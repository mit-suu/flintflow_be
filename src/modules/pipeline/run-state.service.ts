/**
 * run-state.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Khoá step + trạng thái lượt chạy, lưu ở Mongo (`step_runs`) — FLF-177 fix-plan WP-4.
 *
 * BUG-05 (khoá kẹt 15–20 phút): khoá cũ là `Set` trong bộ nhớ, chỉ nhả ở `finally` của lượt chạy. SSE đóng
 * lúc model đang soạn ⇒ step bị khoá tới khi lượt gọi kết thúc, user không có cách nào gỡ. Khoá mới có
 * **TTL + heartbeat**: còn chạy thì cứ mỗi nhịp lại gia hạn `locked_until`; lượt chết thì khoá tự hết hạn
 * sau `LOCK_TTL_MS`, và lượt mới chiếm lại được. Khoá nằm ở DB nên nhiều instance BE cũng đúng.
 *
 * BUG-07 (reload mất gate/câu hỏi): mỗi sự kiện cập nhật `stage`, `questions`, `gate_payload` vào chính
 * dòng đó, nên `GET /steps/:id/run-state` dựng lại được màn hình mà không tốn thêm credit.
 *
 * Huỷ lượt: `POST /steps/:id/cancel` đánh dấu `cancelled` và abort `AbortController` của lượt (nếu lượt
 * đang chạy trong tiến trình này) — runner thấy `signal.aborted` và dừng trước lượt gọi model kế tiếp.
 */

import { randomUUID } from "node:crypto"
import mongoose from "mongoose"
import { StepRun, type RunStage, type RunStatus } from "./run-state.model.js"

export type { RunStage, RunStatus }
import { ApiError } from "../../shared/utils/api-error.js"
import { STEP_NOT_RUNNABLE } from "./step-runner.errors.js"

/** Khoá hết hạn sau ngần này nếu không có nhịp heartbeat nào — lượt chết không giữ step quá lâu. */
export const LOCK_TTL_MS = 45_000
/** Nhịp gia hạn khoá (và phát `heartbeat` cho FE). */
export const HEARTBEAT_MS = 10_000

const STALE_STATUSES: readonly RunStatus[] = ["done", "interrupted", "cancelled"]

export interface RunStateDoc {
  projectId: string
  step_id: string
  run_id: string
  session_id: string | null
  status: RunStatus
  stage: RunStage
  detail_vi: string | null
  batch: { i: number; n: number } | null
  started_at: string
  last_event_at: string
  locked_until: string
  questions: unknown[] | null
  gate_payload: unknown | null
  events: unknown[]
  error: { code: string; message: string } | null
}

const toDoc = (raw: Record<string, unknown>): RunStateDoc => ({
  projectId: String(raw.projectId),
  step_id: String(raw.step_id),
  run_id: String(raw.run_id),
  session_id: raw.session_id === null || raw.session_id === undefined ? null : String(raw.session_id),
  status: raw.status as RunStatus,
  stage: raw.stage as RunStage,
  detail_vi: (raw.detail_vi as string | null) ?? null,
  batch: (raw.batch as { i: number; n: number } | null) ?? null,
  started_at: new Date(raw.started_at as string).toISOString(),
  last_event_at: new Date(raw.last_event_at as string).toISOString(),
  locked_until: new Date(raw.locked_until as string).toISOString(),
  questions: (raw.questions as unknown[] | null) ?? null,
  gate_payload: raw.gate_payload ?? null,
  events: (raw.events as unknown[] | null) ?? [],
  error: (raw.error as { code: string; message: string } | null) ?? null
})

const asObjectId = (projectId: string): mongoose.Types.ObjectId | string =>
  mongoose.isValidObjectId(projectId) ? new mongoose.Types.ObjectId(projectId) : projectId

type RunFilter = Record<string, unknown>

// ─── kho trong bộ nhớ khi chưa nối Mongo ────────────────────────
//
// Test `unit` (vitest project `unit`) chạy step thật với repository giả và KHÔNG nối Mongo. Khoá step là
// hạ tầng của runner, không phải thứ mỗi test phải tự mock, nên khi không có kết nối thì dùng một kho
// trong bộ nhớ với đúng ngữ nghĩa (một tiến trình). Integration/production luôn có kết nối ⇒ dùng
// collection thật và khoá đúng cả khi chạy nhiều instance.

const memory = new Map<string, Record<string, unknown>>()
const memoryKey = (projectId: string, stepId: string): string => `${projectId}::${stepId}`
const useMemory = (): boolean => mongoose.connection.readyState !== 1

/** Test dùng để cô lập giữa các ca. */
export const resetMemoryRuns = (): void => memory.clear()

// ─── abort in-process ───────────────────────────────────────────

const activeAborts = new Map<string, AbortController>()

export const registerAbort = (runId: string, controller: AbortController): void => {
  activeAborts.set(runId, controller)
}

export const unregisterAbort = (runId: string): void => {
  activeAborts.delete(runId)
}

/** Số lượt đang chạy trong tiến trình này — test dùng để chắc chắn không rò AbortController. */
export const activeRunCount = (): number => activeAborts.size

// ─── khoá ───────────────────────────────────────────────────────

export interface AcquireOptions {
  sessionId?: string | null
  by?: string
  stage?: RunStage
  detail_vi?: string | null
}

const lockedMessage = (doc: RunStateDoc): string => {
  const since = new Date(doc.started_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
  return `Bước ${doc.step_id} đang chạy ở lượt trước (bắt đầu ${since}) — huỷ lượt đó rồi chạy lại`
}

/**
 * Chiếm khoá của step. Lượt cũ còn sống (heartbeat chưa quá hạn) ⇒ 409 STEP_NOT_RUNNABLE kèm giờ bắt đầu
 * để FE mời user huỷ lượt cũ. Lượt cũ đã chết (mất SSE, tiến trình restart) ⇒ chiếm lại, không phải chờ.
 */
export const acquireRun = async (projectId: string, stepId: string, options: AcquireOptions = {}): Promise<RunStateDoc> => {
  const now = new Date()
  const runId = randomUUID()
  const fresh = {
    run_id: runId,
    session_id: options.sessionId ?? null,
    by: options.by ?? null,
    status: "running" as RunStatus,
    stage: options.stage ?? "intake",
    detail_vi: options.detail_vi ?? null,
    batch: null,
    started_at: now,
    last_event_at: now,
    locked_until: new Date(now.getTime() + LOCK_TTL_MS),
    questions: null,
    gate_payload: null,
    events: [],
    error: null
  }

  const filter: RunFilter = {
    projectId: asObjectId(projectId),
    step_id: stepId,
    $or: [{ status: { $in: [...STALE_STATUSES] } }, { locked_until: { $lt: now } }]
  }
  if (useMemory()) {
    const key = memoryKey(projectId, stepId)
    const current = memory.get(key)
    const free = !current || STALE_STATUSES.includes(current.status as RunStatus) || new Date(current.locked_until as Date).getTime() < now.getTime()
    if (!free) throw new ApiError(409, lockedMessage(toDoc(current)), STEP_NOT_RUNNABLE)
    const doc = { projectId, step_id: stepId, ...fresh }
    memory.set(key, doc)
    return toDoc(doc)
  }

  const taken = await StepRun.findOneAndUpdate(filter as never, { $set: fresh }, { new: true }).lean()
  if (taken) return toDoc(taken as Record<string, unknown>)

  try {
    const created = await StepRun.create({ projectId: asObjectId(projectId), step_id: stepId, ...fresh })
    return toDoc(created.toObject() as Record<string, unknown>)
  } catch (err) {
    // Dòng đã tồn tại ⇒ có lượt khác đang giữ khoá (hoặc vừa hết hạn trong tích tắc — thử chiếm một lần nữa)
    if (!(err instanceof Error) || !("code" in err) || (err as { code?: number }).code !== 11000) throw err
    const retaken = await StepRun.findOneAndUpdate(filter as never, { $set: fresh }, { new: true }).lean()
    if (retaken) return toDoc(retaken as Record<string, unknown>)
    const current = await getRunState(projectId, stepId)
    throw new ApiError(409, current ? lockedMessage(current) : `Bước ${stepId} đang chạy ở một request khác`, STEP_NOT_RUNNABLE)
  }
}

export interface PatchRun {
  stage?: RunStage
  status?: RunStatus
  detail_vi?: string | null
  batch?: { i: number; n: number } | null
  questions?: unknown[] | null
  gate_payload?: unknown | null
  error?: { code: string; message: string } | null
  /** Sự kiện SSE rút gọn để dựng lại nhật ký sau reload. */
  appendEvent?: unknown
}

/** Số sự kiện giữ lại cho một lượt — đủ dựng lại nhật ký, không phình document. */
export const MAX_KEPT_EVENTS = 100

/** Lượt đã kết thúc — khoá đã nhả, không được gia hạn lại. */
const TERMINAL_STATUSES = ["gate", "done", "interrupted", "cancelled"] as const satisfies readonly RunStatus[]

/**
 * Cập nhật lượt chạy + gia hạn khoá. Chỉ ghi khi `run_id` khớp: lượt cũ đã bị chiếm khoá thì mọi cập nhật
 * của nó rơi vào hư không thay vì đè lên lượt mới. Trả `false` khi lượt không còn là chủ khoá.
 *
 * Cũng bỏ qua khi lượt ĐÃ kết thúc: `tracker.emit`/`tracker.stage` gọi hàm này kiểu bắn-và-quên, nên một
 * lượt touch của sự kiện cuối có thể về đích SAU `finishRun` và gia hạn lại khoá vừa nhả — bước kế tiếp
 * (hoặc chính cổng chốt) nhận "bước đang chạy ở lượt trước" và phải chờ hết TTL.
 */
export const touchRun = async (projectId: string, stepId: string, runId: string, patch: PatchRun = {}): Promise<boolean> => {
  const now = new Date()
  const set: Record<string, unknown> = { last_event_at: now, locked_until: new Date(now.getTime() + LOCK_TTL_MS) }
  for (const key of ["stage", "status", "detail_vi", "batch", "questions", "gate_payload", "error"] as const) {
    if (patch[key] !== undefined) set[key] = patch[key]
  }
  const update: Record<string, unknown> = { $set: set }
  if (patch.appendEvent !== undefined) update.$push = { events: { $each: [patch.appendEvent], $slice: -MAX_KEPT_EVENTS } }

  if (useMemory()) {
    const doc = memory.get(memoryKey(projectId, stepId))
    if (!doc || doc.run_id !== runId) return false
    if ((TERMINAL_STATUSES as readonly string[]).includes(String(doc.status)) && patch.status === undefined) return false
    Object.assign(doc, set)
    if (patch.appendEvent !== undefined) doc.events = [...((doc.events as unknown[]) ?? []), patch.appendEvent].slice(-MAX_KEPT_EVENTS)
    return true
  }

  const result = await StepRun.updateOne(
    { projectId: asObjectId(projectId), step_id: stepId, run_id: runId, ...(patch.status === undefined ? { status: { $nin: TERMINAL_STATUSES as unknown as RunStatus[] } } : {}) },
    update
  )
  return result.matchedCount > 0
}

/** Kết thúc lượt: nhả khoá (đặt `locked_until` về quá khứ) và ghi trạng thái cuối. */
export const finishRun = async (projectId: string, stepId: string, runId: string, status: RunStatus, patch: PatchRun = {}): Promise<void> => {
  const set: Record<string, unknown> = { status, last_event_at: new Date(), locked_until: new Date(0) }
  for (const key of ["stage", "detail_vi", "questions", "gate_payload", "error"] as const) {
    if (patch[key] !== undefined) set[key] = patch[key]
  }
  if (useMemory()) {
    const doc = memory.get(memoryKey(projectId, stepId))
    if (doc && doc.run_id === runId) Object.assign(doc, set)
  } else {
    await StepRun.updateOne({ projectId: asObjectId(projectId), step_id: stepId, run_id: runId }, { $set: set })
  }
  unregisterAbort(runId)
}

export const getRunState = async (projectId: string, stepId: string): Promise<RunStateDoc | null> => {
  if (useMemory()) {
    const doc = memory.get(memoryKey(projectId, stepId))
    return doc ? toDoc(doc) : null
  }
  const doc = await StepRun.findOne({ projectId: asObjectId(projectId), step_id: stepId }).lean()
  return doc ? toDoc(doc as Record<string, unknown>) : null
}

/** Lượt còn sống của dự án (pill "đang chạy nền" khôi phục sau khi mở lại trang). */
export const getActiveRun = async (projectId: string): Promise<RunStateDoc | null> => {
  const docs = useMemory()
    ? [...memory.values()]
        .filter((d) => String(d.projectId) === projectId && !STALE_STATUSES.includes(d.status as RunStatus))
        .sort((a, b) => new Date(b.last_event_at as Date).getTime() - new Date(a.last_event_at as Date).getTime())
        .slice(0, 5)
    : ((await StepRun.find({ projectId: asObjectId(projectId), status: { $nin: [...STALE_STATUSES] } } as never)
        .sort({ last_event_at: -1 })
        .limit(5)
        .lean()) as Record<string, unknown>[])
  const alive = docs.map(toDoc).find((d) => d.status !== "running" || new Date(d.locked_until).getTime() > Date.now())
  return alive ?? null
}

/** Step đang thật sự chạy (khoá còn hiệu lực) — resume không được revert nội dung đang được ghi. */
export const isStepRunning = async (projectId: string, stepId: string): Promise<boolean> => {
  const doc = await getRunState(projectId, stepId)
  return doc !== null && doc.status === "running" && new Date(doc.locked_until).getTime() > Date.now()
}

export interface CancelResult {
  cancelled: boolean
  run_id: string | null
}

/**
 * Huỷ lượt đang chạy: abort lượt gọi model (nếu chạy trong tiến trình này) rồi nhả khoá. Lượt chạy ở
 * instance khác không abort được từ đây, nhưng khoá đã nhả nên user chạy lại được ngay — lượt cũ sẽ tự
 * dừng ở lần `touchRun` kế tiếp vì không còn là chủ khoá.
 */
export const cancelRun = async (projectId: string, stepId: string, runId?: string): Promise<CancelResult> => {
  const current = await getRunState(projectId, stepId)
  if (!current || STALE_STATUSES.includes(current.status)) return { cancelled: false, run_id: current?.run_id ?? null }
  if (runId && runId !== current.run_id) return { cancelled: false, run_id: current.run_id }

  activeAborts.get(current.run_id)?.abort()
  unregisterAbort(current.run_id)
  const cancelled = { status: "cancelled" as RunStatus, last_event_at: new Date(), locked_until: new Date(0), questions: null }
  if (useMemory()) {
    const doc = memory.get(memoryKey(projectId, stepId))
    if (doc) Object.assign(doc, cancelled)
  } else {
    await StepRun.updateOne({ projectId: asObjectId(projectId), step_id: stepId, run_id: current.run_id }, { $set: cancelled })
  }
  return { cancelled: true, run_id: current.run_id }
}

/** Dọn lượt chạy của một dự án (test, hoặc xoá dự án). */
export const clearRuns = async (projectId: string): Promise<void> => {
  if (useMemory()) {
    for (const [key, doc] of memory) if (String(doc.projectId) === projectId) memory.delete(key)
    return
  }
  await StepRun.deleteMany({ projectId: asObjectId(projectId) })
}
