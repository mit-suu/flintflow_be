/**
 * step-runner.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Khung hành động dùng chung cho 12 phase (Phases §3, `assets/skills/action/srs-orchestrator/SKILL.md`):
 * Intake → Elicit → Draft → Render → Review → Gate (khung "sẵn sàng gate", hành động gate ở `gate.service`)
 * → Meter mỗi lượt gọi model.
 *
 * `runStep` là điểm vào công khai cho HTTP (SSE, `pipeline.controller.ts`) VÀ cho T14 gọi trực tiếp
 * (không qua HTTP) — tham số `deps` cắm mock provider trong test, không cần mock module.
 *
 * Lỗi: guard-clause (session không pipeline, step không tồn tại/không tới lượt, base_version lệch,
 * CALL_LIMIT đã đầy trước khi chạy) NÉM lỗi trước khi gọi `emit` lần nào — bên gọi HTTP (controller) coi
 * đây là lỗi JSON thường (403/404/409). Lỗi giữa chừng (draft hỏng, ghi Spine xung đột…) cũng ném —
 * controller phát nó thành sự kiện SSE `error` vì lúc đó header đã gửi (xem `pipeline.controller.ts`).
 *
 * F2 (review T13): trần 8 lượt chỉ kiểm ở cửa vào là chưa đủ — hai lượt gọi khác nhau (elicit rồi draft)
 * trong CÙNG một `runStep` có thể lần lượt vượt trần nếu chỉ kiểm một lần. Mỗi lượt gọi model (elicit,
 * draft/regenerate/revision qua `runDraftPhase`, review qua `runRenderReviewPhase`) tự kiểm trần + ghi
 * usage `reserved` NGAY TRƯỚC khi gọi model (xem `meter.service.ts`). Đồng thời khoá in-process theo
 * `${projectId}:${stepId}` (`acquireStepLock`/`releaseStepLock`) chặn `/run`, `/gate`, resume chạy đồng
 * thời trên cùng step — 409 STEP_NOT_RUNNABLE cho request thứ hai. Giả định single-instance (một tiến
 * trình Node) — xem `docs/spec-gaps.md`.
 */

import { randomUUID } from "node:crypto"
import { env } from "../../config/env.js"
import { ChatSession, type IChatMessage } from "../project/chat-session.model.js"
import { Project } from "../project/project.model.js"
import { assemble } from "../render/assemble.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { applyTransaction, CHANGE_RANGE_INVALID } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import type { Spine, SpineRecord, StepState } from "../spine/spine.types.js"
import * as flagsService from "../spine/flags.service.js"
import { renderDiagrams, type DiagramServiceDeps } from "../diagram/diagram.service.js"
import type { RenderTarget } from "../diagram/renderers/index.js"
import { NONSCREEN_LOOP, getStep, nextStep as nextStepOf } from "./step-registry.js"
import { buildStepContext, getStepSpec, parseStepId, type StepContext } from "./context-projection.js"
import { draftOps, type DraftCallKind, type DraftExecutor } from "./draft-to-ops.js"
import { S9_FREE_STEPS, S9_PHASE, runS9Step } from "./s9/run-s9-step.js"
import * as meter from "./meter.service.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import type { ElicitOutput, OpTransaction, ReviewOutput } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { PIPELINE_ERROR_STATUS, gateActionSchema, type PipelineErrorCode, type StepEvent } from "./pipeline.dto.js"
import type { z } from "zod"

type GateAction = z.infer<typeof gateActionSchema>

export const NOT_PIPELINE_SESSION = "NOT_PIPELINE_SESSION"
export const STEP_NOT_RUNNABLE = "STEP_NOT_RUNNABLE"
export const CALL_LIMIT = "CALL_LIMIT"
export const CALLS_LIMIT = 8
export const REGENERATE_LIMIT_COUNT = 3

export type Emit = (event: StepEvent) => void

// ─── dependency injection (mock provider trong test / T14) ───────

export type ElicitExecutor = (input: AiActionInput, projectId: string, userId: string) => Promise<AiActionResult<ElicitOutput>>
export type ReviewExecutor = (input: AiActionInput, projectId: string, userId: string) => Promise<AiActionResult<ReviewOutput>>

export interface StepRunnerDeps {
  /** Draft/Regenerate/Revision — mặc định gọi `executeAiAction` (T04 reserve/deduct/release credit thật ở ví). */
  draftExecutor: DraftExecutor
  elicitExecutor: ElicitExecutor
  /** Chỉ dùng khi `REVIEW_LLM_ENABLED=true` (mặc định tắt). */
  reviewExecutor: ReviewExecutor
  renderDeps?: Partial<DiagramServiceDeps>
  /** S-8.2: ghép RenderedDocument ở `spineVersion` và lưu cache — mặc định gọi `assemble()` (T15). */
  assembleDocument: (projectId: string, spineVersion: number) => Promise<void>
  /** F8: đóng tab/mất mạng giữa chừng — controller abort khi `req` đóng. Runner kiểm trước mỗi lượt gọi
   *  model và khi đang chờ answer; không áp dụng cho `/gate` (không SSE, không có kết nối để huỷ). */
  signal?: AbortSignal
  /** Người dùng chủ động chạy lại step đã `accepted` (B7 reopen) — xem `runStepRequestSchema.reopen`. */
  reopen?: boolean
}

/**
 * `signal` được gắn vào từng lượt gọi model: client đóng SSE (reload trang) ⇒ lượt gọi đang bay bị huỷ ngay,
 * `runStep` thoát và **nhả khoá step**. Không có nó thì lượt gọi chạy hết (có thể vài phút) và lần chạy sau
 * nhận `STEP_NOT_RUNNABLE`.
 */
export const defaultStepRunnerDeps = (signal?: AbortSignal): StepRunnerDeps => ({
  draftExecutor: (actionType, input, projectId, userId) => executeAiAction<OpTransaction>(actionType, input, projectId, userId, signal ? { signal } : {}),
  elicitExecutor: (input, projectId, userId) => executeAiAction<ElicitOutput>(ActionType.ELICIT, input, projectId, userId, signal ? { signal } : {}),
  reviewExecutor: (input, projectId, userId) => executeAiAction<ReviewOutput>(ActionType.REVIEW, input, projectId, userId, signal ? { signal } : {}),
  assembleDocument: async (projectId, spineVersion) => {
    const project = await Project.findById(projectId, { name: 1 }).lean()
    if (!project) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    await assemble(projectId, project.name, spineVersion)
  }
})

/**
 * S-8.2 là step tất định, không skill ⇒ không Elicit/Draft. Việc thật của nó là ghép tài liệu: trước đây
 * runner chỉ tính cờ rồi phát `gate_ready`, `POST /assemble` không được gọi ở đâu ⇒ `/document` và
 * `/export/word` luôn 409 NO_WORKING_DRAFT dù S-8.2 đã accepted.
 */
export const ASSEMBLE_STEP = "S-8.2"

// ─── khoá in-process theo step (F2) ─────────────────────────────────

const runningSteps = new Set<string>()
const stepLockKey = (projectId: string, stepId: string): string => `${projectId}::${stepId}`

/** Chiếm khoá step. 409 STEP_NOT_RUNNABLE nếu step đang chạy dở ở một request khác (cùng tiến trình). */
export const acquireStepLock = (projectId: string, stepId: string): void => {
  const key = stepLockKey(projectId, stepId)
  if (runningSteps.has(key)) {
    throw new ApiError(409, `Step ${stepId} đang được xử lý ở một request khác`, STEP_NOT_RUNNABLE)
  }
  runningSteps.add(key)
}

export const releaseStepLock = (projectId: string, stepId: string): void => {
  runningSteps.delete(stepLockKey(projectId, stepId))
}

export const isStepLocked = (projectId: string, stepId: string): boolean => runningSteps.has(stepLockKey(projectId, stepId))

// ─── F13: revert không được đụng change ngoài step ──────────────────

/**
 * `revertRange` (op-engine) áp nghịch đảo cả dải theo seq, kể cả change không thuộc step (vd user sửa tay
 * qua `POST /changes` xen giữa dải của step). Kiểm trước, từ chối thay vì revert âm thầm đè lên thay đổi
 * không thuộc step. Dùng ở gate regenerate + resume.
 */
export const assertRangeOwnedByStep = async (projectId: string, stepId: string, firstSeq: number, lastSeq: number): Promise<void> => {
  const changes = await spineRepository.listChanges(projectId, { fromSeq: firstSeq, toSeq: lastSeq })
  const foreign = changes.find((c) => c.step_id !== stepId)
  if (foreign) {
    throw new ApiError(422, `Dải seq ${firstSeq}–${lastSeq} của step ${stepId} chứa thay đổi không thuộc step (seq ${foreign.seq})`, CHANGE_RANGE_INVALID)
  }
}

// ─── chờ trả lời Elicit (answer_needed) trong cùng luồng SSE ──────

export interface AnswerInput {
  question_id: string
  answer: string | string[]
}

interface PendingAnswer {
  resolve: (answers: AnswerInput[]) => void
  timeout: ReturnType<typeof setTimeout>
}

/** 15 phút — đủ để đọc câu hỏi và trả lời; không giữ promise treo vô hạn nếu người dùng bỏ đi. */
export const ANSWER_WAIT_TIMEOUT_MS = 15 * 60 * 1000

const pendingAnswers = new Map<string, PendingAnswer>()

const answerKey = (projectId: string, stepId: string, sessionId: string): string => `${projectId}::${stepId}::${sessionId}`

/** `POST /answer` gọi hàm này. `false` ⇒ không có lượt chờ khớp (step không ở `answer_needed`). */
export const submitAnswer = (projectId: string, stepId: string, sessionId: string, answers: AnswerInput[]): boolean => {
  const key = answerKey(projectId, stepId, sessionId)
  const pending = pendingAnswers.get(key)
  if (!pending) return false
  clearTimeout(pending.timeout)
  pendingAnswers.delete(key)
  pending.resolve(answers)
  return true
}

/** F8: đang chờ answer mà client đóng kết nối ⇒ dọn lượt chờ, không treo promise vô thời hạn. */
const waitForAnswer = (projectId: string, stepId: string, sessionId: string, signal?: AbortSignal): Promise<AnswerInput[]> => {
  const key = answerKey(projectId, stepId, sessionId)
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      pendingAnswers.delete(key)
      if (signal && onAbort) signal.removeEventListener("abort", onAbort)
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new ApiError(409, `Hết thời gian chờ trả lời câu hỏi của step ${stepId}`, STEP_NOT_RUNNABLE))
    }, ANSWER_WAIT_TIMEOUT_MS)
    const onAbort = (): void => {
      clearTimeout(timeout)
      cleanup()
      reject(new ApiError(409, `Client đã đóng kết nối trong khi chờ trả lời step ${stepId}`, STEP_NOT_RUNNABLE))
    }
    if (signal?.aborted) {
      clearTimeout(timeout)
      reject(new ApiError(409, `Client đã đóng kết nối trong khi chờ trả lời step ${stepId}`, STEP_NOT_RUNNABLE))
      return
    }
    signal?.addEventListener("abort", onAbort)
    pendingAnswers.set(key, {
      resolve: (answers) => {
        clearTimeout(timeout)
        cleanup()
        resolve(answers)
      },
      timeout
    })
  })
}

/** F8: kiểm huỷ TRƯỚC mỗi lượt gọi model — không gọi model nữa nếu client đã đóng kết nối. */
const assertNotAborted = (signal: AbortSignal | undefined, stepId: string): void => {
  if (signal?.aborted) {
    throw new ApiError(409, `Client đã đóng kết nối cho step ${stepId}`, STEP_NOT_RUNNABLE)
  }
}

// ─── helper ────────────────────────────────────────────────────────

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

const refresh = async (projectId: string): Promise<{ spine: Spine; spineVersion: number }> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  return { spine: stripRecord(record), spineVersion: record.spine_version }
}

const pushTranscript = async (sessionId: string, stepId: string, role: "user" | "ai", content: string): Promise<void> => {
  const msg: IChatMessage = { role, content, step: stepId, createdAt: new Date() }
  await ChatSession.updateOne({ _id: sessionId }, { $push: { messages: msg } })
}

/** `calls_used`/`regenerate_used` của vòng hiện tại của step. */
const usageCounts = meter.roundCounts

// ─── vòng S-5 theo màn (T18) ───────────────────────────────────────

/**
 * Hai step "sổ sách" của vòng S-5 KHÔNG gọi model dù registry để `deterministic: false`:
 * `S-5.1` chỉ dời con trỏ sang màn kế tiếp, `S-5.5` chỉ là cổng ký duyệt màn (gate đặt `signed_off`).
 * Trả tiền cho model để chọn phần tử đầu hàng đợi là lãng phí; đổi `deterministic` trong
 * `assets/step-registry.json` lại cần PR `contract-change` (đóng băng ở M2) — ghi ở `docs/spec-gaps.md`.
 */
export const LOOP_BOOKKEEPING_TEMPLATES: ReadonlySet<string> = new Set(["S-5.1", "S-5.5"])

/** Phases §6.2: một lượt Draft chỉ ôm tối đa 6 function — nhiều hơn thì model bỏ sót hoặc cắt giữa chừng. */
export const FUNCTION_BATCH_SIZE = 6

/** Step S-5.2 / S-5.4 viết chi tiết từng function ⇒ chia lô; S-5.1/S-5.3/S-5.5 thì không. */
const BATCHED_TEMPLATES: ReadonlySet<string> = new Set(["S-5.2", "S-5.4"])

const isLoopBookkeeping = (stepId: string): boolean => LOOP_BOOKKEEPING_TEMPLATES.has(getStep(stepId).template_id)

/**
 * `S-5.1`: đặt `progress.screen_cursor` sang màn của vòng này và chuyển màn từ `pending` sang
 * `in_progress`. Vòng `@nonscreen` (function không thuộc màn nào) đặt cursor về `null`.
 * Màn đã `signed_off`/`placeholder` giữ nguyên `detail_status` — quay lại vòng cũ không hạ cấp nó.
 */
export const loopCursorOps = (spine: Spine, stepId: string): Op[] => {
  const step = getStep(stepId)
  if (step.template_id !== "S-5.1" || step.loop === null) return []

  if (step.loop === NONSCREEN_LOOP) {
    return spine.progress.screen_cursor === null ? [] : [{ op: "set", path: "progress.screen_cursor", value: null }]
  }

  const screen = spine.screens.find((s) => s.id === step.loop)
  if (!screen) return []
  const ops: Op[] = []
  if (spine.progress.screen_cursor !== screen.id) ops.push({ op: "set", path: "progress.screen_cursor", value: screen.id })
  if (screen.detail_status === "pending") ops.push({ op: "set", path: `screens[id=${screen.id}].detail_status`, value: "in_progress" })
  return ops
}

/** Màn `pending` đầu tiên của hàng đợi; hết ⇒ null (runner chuyển sang vòng `@nonscreen`). */
export const nextPendingScreen = (spine: Spine): string | null => {
  const byId = new Map(spine.screens.map((s) => [s.id, s]))
  return spine.progress.screen_queue.find((id) => byId.get(id)?.detail_status === "pending") ?? null
}

/** Function thuộc vòng hiện tại: theo màn, hoặc `screen_id === null` với vòng `@nonscreen`. */
const functionsOfLoop = (spine: Spine, loop: string): string[] =>
  spine.functions
    .filter((f) => (loop === NONSCREEN_LOOP ? f.screen_id === null : f.screen_id === loop))
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
    .map((f) => f.id)

/**
 * Chia function của vòng thành các lô ≤ `FUNCTION_BATCH_SIZE`. Step không chia lô (hoặc ít function)
 * trả một lô duy nhất `[]` — nghĩa là "dùng nguyên projection của step, không lọc".
 */
export const functionBatches = (spine: Spine, stepId: string): string[][] => {
  const step = getStep(stepId)
  if (!BATCHED_TEMPLATES.has(step.template_id) || step.loop === null) return [[]]
  const ids = functionsOfLoop(spine, step.loop)
  if (ids.length <= FUNCTION_BATCH_SIZE) return [[]]

  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += FUNCTION_BATCH_SIZE) batches.push(ids.slice(i, i + FUNCTION_BATCH_SIZE))
  return batches
}

/**
 * Context của một lô: giữ nguyên mọi thứ, chỉ thu hẹp phần `functions*` của projection về đúng lô.
 * Model chỉ thấy function trong lô nên chỉ phát op cho chúng — không cần thêm biến prompt mới
 * (`draft-to-ops.ts` là vùng của T11).
 */
export const batchContext = (ctx: StepContext, functionIds: readonly string[]): StepContext => {
  if (functionIds.length === 0) return ctx
  const keep = new Set(functionIds)
  const projection: Record<string, unknown> = {}
  for (const [selector, value] of Object.entries(ctx.projection)) {
    projection[selector] =
      selector.startsWith("functions") && Array.isArray(value)
        ? value.filter((el) => typeof el === "object" && el !== null && keep.has((el as { id?: string }).id ?? ""))
        : value
  }
  return { ...ctx, projection }
}

// ─── Draft + ghi Spine (dùng chung cho /run và gate regenerate/revision) ──

export interface DraftPhaseResult {
  spineVersion: number
  applied: boolean
}

/**
 * Chạy một lượt Draft (draft-to-ops T11) và ghi Spine (op engine T08). F2/F11: kiểm trần + ghi usage
 * `reserved` TRƯỚC khi gọi model, `finalizeCall`/`releaseCall` sau. 409 SPINE_VERSION_CONFLICT ⇒ hoàn
 * usage[] của lượt này (không tiêu trần) rồi ném lại. `emit` có thể là no-op (gate.service không stream).
 */
export const runDraftPhase = async (
  projectId: string,
  stepId: string,
  ctx: StepContext,
  spine: Spine,
  userId: string,
  callKind: DraftCallKind,
  emit: Emit,
  deps: StepRunnerDeps,
  extra: { answers?: string; revisionRequest?: string } = {}
): Promise<DraftPhaseResult> => {
  assertNotAborted(deps.signal, stepId)
  const currentFirstSeq = spine.steps.find((s) => s.id === stepId)?.first_seq ?? null
  const { calls_used } = await meter.roundCounts(projectId, stepId, currentFirstSeq)
  if (calls_used >= CALLS_LIMIT) throw new ApiError(409, `Step ${stepId} đã dùng hết ${CALLS_LIMIT} lượt gọi model`, CALL_LIMIT)

  const reservedId = await meter.reserveCall(projectId, userId, stepId, callKind)
  let draftResult: Awaited<ReturnType<typeof draftOps>>
  try {
    draftResult = await draftOps(projectId, stepId, ctx, { userId, executor: deps.draftExecutor, spine, callKind, ...extra })
  } catch (err) {
    await meter.releaseCall(reservedId)
    throw err
  }

  const usageEntries = draftResult.usage.map((u) => ({
    call_kind: u.call_kind,
    attempt: u.attempt,
    tokens_in: u.tokens_in,
    tokens_out: u.tokens_out,
    cost: u.cost,
    logId: u.logId
  }))

  let usageIds: string[]
  if (usageEntries.length === 0) {
    await meter.releaseCall(reservedId)
    usageIds = []
  } else {
    const [first, ...rest] = usageEntries
    await meter.finalizeCall(reservedId, first)
    const restIds = rest.length > 0 ? await meter.recordUsage(projectId, userId, stepId, rest) : []
    usageIds = [reservedId, ...restIds]
  }

  for (const attempt of draftResult.attempts) emit({ type: "draft", step_id: stepId, attempt: attempt.attempt })

  if (!draftResult.txn) return { spineVersion: spine.spine_version, applied: false }

  try {
    const applied = await applyTransaction(projectId, draftResult.txn)
    emit({
      type: "ops_applied",
      step_id: stepId,
      txn: applied.txn ?? randomUUID(),
      spine_version: applied.spine_version,
      changes: applied.changes.map((c) => ({ op: c.op, path: c.path, before: c.before, value: c.value, reason: c.reason }))
    })
    return { spineVersion: applied.spine_version, applied: true }
  } catch (err) {
    if (err instanceof ApiError && err.code === spineRepository.SPINE_VERSION_CONFLICT) {
      // 409 hai tab: model đã trả lời (credit đã deduct ở ví) nhưng Spine không ghi được — hoàn usage[]
      // (không tính vào trần) và hoàn credit về ví.
      await meter.refundUsage(usageIds)
    }
    throw err
  }
}

/** Render mọi diagram của step (nếu có) + Review (deterministic check; LLM review tuỳ `REVIEW_LLM_ENABLED`). */
export const runRenderReviewPhase = async (
  projectId: string,
  stepId: string,
  renders: readonly RenderTarget["kind"][],
  loop: string | null,
  userId: string,
  emit: Emit,
  deps: StepRunnerDeps
): Promise<number> => {
  let spineVersion = (await refresh(projectId)).spineVersion

  if (renders.length > 0) {
    const targets: RenderTarget[] = renders.map((kind) => ({ kind, owner_id: kind === "screen_layout" ? loop : null }))
    const result = await renderDiagrams(projectId, targets, {
      by: userId,
      step_id: stepId,
      ...(deps.renderDeps ? { deps: deps.renderDeps } : {})
    })
    spineVersion = result.spine_version
    for (const id of result.rendered) {
      const diagram = result.diagrams.find((d) => d.id === id)
      emit({
        type: "render",
        step_id: stepId,
        diagram_id: id,
        render_status: diagram?.render_status ?? "error",
        ...(diagram?.error ? { error: diagram.error } : {})
      })
    }
  }

  const flagsResult = await flagsService.recompute(projectId, { by: userId })
  spineVersion = flagsResult.checked_at_version
  const redOpen = flagsResult.flags.filter((f) => f.level === "red" && f.resolved_at === null).length
  const yellowOpen = flagsResult.flags.filter((f) => f.level === "yellow" && f.resolved_at === null).length
  emit({ type: "flags", step_id: stepId, red_open: redOpen, yellow_open: yellowOpen })

  // Lớp phủ LLM review — tắt mặc định (đọc process.env trực tiếp, không qua src/config theo yêu cầu task).
  // F2/F11: kiểm trần + reserve trước khi gọi, như elicit/draft. Lớp phủ không chặn step: lỗi/hết trần chỉ log.
  if (env.REVIEW_LLM_ENABLED && !deps.signal?.aborted) {
    const { spine: spineForReview } = await refresh(projectId)
    const currentFirstSeq = spineForReview.steps.find((s) => s.id === stepId)?.first_seq ?? null
    const { calls_used } = await meter.roundCounts(projectId, stepId, currentFirstSeq)
    if (calls_used >= CALLS_LIMIT) {
      console.error(`[step-runner] LLM review bị bỏ qua cho ${stepId}: đã hết ${CALLS_LIMIT} lượt gọi model`)
    } else {
      const reservedId = await meter.reserveCall(projectId, userId, stepId, "review")
      try {
        const spine = spineForReview
        const spec = getStepSpec(stepId)
        const result = await deps.reviewExecutor(
          { promptVariables: { step_id: stepId, step_name: spec.label_en, working_mode: spine.project.working_mode ?? "coaching" } },
          projectId,
          userId
        )
        await meter.finalizeCall(reservedId, {
          call_kind: "review",
          attempt: 1,
          tokens_in: result.tokensUsed.promptTokens,
          tokens_out: result.tokensUsed.completionTokens,
          cost: result.cost,
          logId: result.logId || null
        })
      } catch (err) {
        // Review LLM là lớp phủ thêm, không chặn step — lỗi chỉ log.
        await meter.releaseCall(reservedId)
        console.error(`[step-runner] LLM review thất bại cho ${stepId}:`, err)
      }
    }
  }

  return spineVersion
}

/** Ghi lại `steps[id].first_seq/last_seq` theo dải change thực tế đã ghi kể từ `startSeq`. */
export const trackSeqRange = async (
  projectId: string,
  spineVersion: number,
  stepId: string,
  userId: string,
  startSeq: number,
  existing: Pick<StepState, "first_seq" | "last_seq"> | undefined
): Promise<number> => {
  const changes = (await spineRepository.listChanges(projectId, { fromSeq: startSeq })).filter((c) => c.step_id === stepId)
  if (changes.length === 0) return spineVersion

  const minSeq = Math.min(...changes.map((c) => c.seq))
  const maxSeq = Math.max(...changes.map((c) => c.seq))
  const firstSeq = existing?.first_seq ?? minSeq
  const lastSeq = existing?.last_seq !== null && existing?.last_seq !== undefined ? Math.max(existing.last_seq, maxSeq) : maxSeq
  if (firstSeq === existing?.first_seq && lastSeq === existing?.last_seq) return spineVersion

  const ops: Op[] = [
    { op: "set", path: `steps[id=${stepId}].first_seq`, value: firstSeq },
    { op: "set", path: `steps[id=${stepId}].last_seq`, value: lastSeq }
  ]
  const result = await applyTransaction(projectId, { base_version: spineVersion, ops, by: userId, step_id: stepId, reason: "step-runner: cập nhật dải seq" })
  return result.spine_version
}

// ─── guard clauses ─────────────────────────────────────────────────

/** F15: session không tồn tại/không thuộc project là cùng một lớp lỗi với "không phải session pipeline"
 *  (client không được suy ra Spine có tồn tại hay không từ mã lỗi) — cả hai đều 403 NOT_PIPELINE_SESSION. */
export const requirePipelineSession = async (projectId: string, sessionId: string): Promise<void> => {
  const session = await ChatSession.findById(sessionId)
  if (!session || String(session.projectId) !== String(projectId) || !session.is_pipeline) {
    throw new ApiError(403, "Session này không phải session pipeline của dự án — chỉ dùng để hỏi đáp (CHAT)", NOT_PIPELINE_SESSION)
  }
}

// ─── điểm vào công khai ─────────────────────────────────────────────

/**
 * Chạy một step trọn vẹn: Intake → Elicit → Draft → Render → Review → phát `gate_ready`.
 *
 * `deps` tuỳ chọn — mặc định gọi model thật qua `executeAiAction` (T04 lo reserve/deduct/release credit ở
 * ví). Test/T14 truyền `deps.draftExecutor`/`deps.elicitExecutor` để cắm provider giả lập mà không cần
 * HTTP hay mock module — đây là "cách chạy step không cần HTTP" công khai cho T14/T16.
 */
export const runStep = async (
  projectId: string,
  stepId: string,
  sessionId: string,
  userId: string,
  emit: Emit,
  deps: Partial<StepRunnerDeps> = {}
): Promise<void> => {
  acquireStepLock(projectId, stepId)
  try {
    const d: StepRunnerDeps = { ...defaultStepRunnerDeps(deps.signal), ...deps }

    await requirePipelineSession(projectId, sessionId)
    const stepDef = getStep(stepId) // 404 STEP_NOT_FOUND nếu id sai
    const spec = getStepSpec(stepId)
    const needsDraft = spec.skill !== null && !stepDef.deterministic && !isLoopBookkeeping(stepId)

    let { spine, spineVersion } = await refresh(projectId)
    let existingStep = spine.steps.find((s) => s.id === stepId)

    if (existingStep?.status === "skipped") {
      throw new ApiError(409, `Step ${stepId} không áp dụng cho template của dự án — bật lại ở kế hoạch step trước khi chạy`, STEP_NOT_RUNNABLE)
    }
    if (existingStep?.status === "accepted") {
      if (!d.reopen) {
        throw new ApiError(409, `Step ${stepId} đã accepted — chạy lại phải mở lại bước (reopen) hoặc gate revision/regenerate (B7)`, STEP_NOT_RUNNABLE)
      }
      // Mở lại đúng như gate revision/regenerate: vòng mới, bỏ mốc seq và thời điểm chốt cũ (B7/F1)
      const reopened = await applyTransaction(projectId, {
        base_version: spineVersion,
        ops: [
          { op: "set", path: `steps[id=${stepId}].status`, value: "revision_requested" },
          { op: "set", path: `steps[id=${stepId}].first_seq`, value: null },
          { op: "set", path: `steps[id=${stepId}].last_seq`, value: null },
          { op: "set", path: `steps[id=${stepId}].accepted_at`, value: null }
        ],
        by: userId,
        step_id: stepId,
        reason: "run: mở lại step đã accepted (B7)"
      })
      spine = reopened.spine
      spineVersion = reopened.spine_version
      existingStep = spine.steps.find((s) => s.id === stepId)
    }
    if (!existingStep) {
      const next = nextStepOf(spine)
      if (!next || next.id !== stepId) throw new ApiError(409, `Step ${stepId} chưa tới lượt chạy`, STEP_NOT_RUNNABLE)
    }

    if (needsDraft) {
      const { calls_used } = await usageCounts(projectId, stepId, existingStep?.first_seq ?? null)
      if (calls_used >= CALLS_LIMIT) throw new ApiError(409, `Step ${stepId} đã dùng hết ${CALLS_LIMIT} lượt gọi model`, CALL_LIMIT)
    }

    // ─── init: cập nhật progress cursor + đặt step in_progress (B7: reset vòng khi reopen sau accepted) ──
    const phaseChanged = spine.progress.current_phase !== stepDef.phase
    const reopenedAfterAccept = existingStep?.status === "revision_requested" && existingStep.accepted_at !== null

    const initOps: Op[] = []
    if (phaseChanged) initOps.push({ op: "set", path: "progress.current_phase", value: stepDef.phase }, { op: "set", path: "progress.elicit_turns_this_phase", value: 0 })
    if (spine.progress.current_step !== stepId) initOps.push({ op: "set", path: "progress.current_step", value: stepId })

    if (!existingStep) {
      initOps.push({ op: "add", path: "steps[]", value: { id: stepId, status: "in_progress", first_seq: null, last_seq: null, accepted_at: null } })
    } else if (existingStep.status !== "in_progress") {
      initOps.push({ op: "set", path: `steps[id=${stepId}].status`, value: "in_progress" })
      if (reopenedAfterAccept) {
        initOps.push(
          { op: "set", path: `steps[id=${stepId}].first_seq`, value: null },
          { op: "set", path: `steps[id=${stepId}].last_seq`, value: null },
          { op: "set", path: `steps[id=${stepId}].accepted_at`, value: null }
        )
      }
    }

    if (initOps.length > 0) {
      const applied = await applyTransaction(projectId, { base_version: spineVersion, ops: initOps, by: userId, step_id: stepId, reason: "step-runner: init step" })
      spineVersion = applied.spine_version
      ;({ spine, spineVersion } = await refresh(projectId))
    }

    // T18 — S-5.1: dời con trỏ vòng lặp sang màn của vòng này. Ghi TRƯỚC `startSeq` như init ops: đây là
    // sổ sách của vòng, không phải nội dung do step sinh ra (resume revert dải nội dung không được xoá nó).
    const cursorOps = loopCursorOps(spine, stepId)
    if (cursorOps.length > 0) {
      const applied = await applyTransaction(projectId, { base_version: spineVersion, ops: cursorOps, by: userId, step_id: stepId, reason: "step-runner: con trỏ vòng S-5" })
      spineVersion = applied.spine_version
    }
    // startSeq CHỈ tính từ sau init ops: seq đánh dấu status=in_progress không phải nội dung của step, không
    // thuộc dải first_seq/last_seq — nếu không, resume revert dải sẽ xoá luôn phần tử `steps[]` (revert của
    // "add") rồi việc set lại status=pending bên dưới sẽ path_not_resolved.
    const startSeq = await spineRepository.nextSeq(projectId)
    ;({ spine, spineVersion } = await refresh(projectId))
    const stepStateForRound: Pick<StepState, "first_seq" | "last_seq"> | undefined = reopenedAfterAccept ? { first_seq: null, last_seq: null } : existingStep

    const ctx = await buildStepContext(projectId, stepId, { sessionId })
    if (phaseChanged) emit({ type: "intake", step_id: stepId, phase: stepDef.phase, empty_fields: ctx.emptyFields })

    let answersText = ctx.transcriptTail

    // T19 — pha S-9: việc của từng step nằm ở `s9/run-s9-step.ts`, không đi qua STEP_SKILLS.
    // S-9.1/S-9.5 không gọi model và không Meter (hết credit vẫn quét và vẫn ký baseline được).
    if (stepDef.phase === S9_PHASE) {
      if (!S9_FREE_STEPS.has(parseStepId(stepId).base)) {
        assertNotAborted(d.signal, stepId)
        emit({ type: "draft", step_id: stepId, attempt: 1 })
      }
      await runS9Step(projectId, stepId, userId, { draftExecutor: d.draftExecutor, reviewExecutor: d.reviewExecutor, sessionId })
      ;({ spine, spineVersion } = await refresh(projectId))
    }

    if (needsDraft) {
      const workingMode = spine.project.working_mode ?? "coaching"
      const shouldElicit = workingMode === "coaching" || spine.progress.elicit_turns_this_phase < 2

      if (shouldElicit) {
        assertNotAborted(d.signal, stepId)
        const { calls_used: callsBeforeElicit } = await meter.roundCounts(projectId, stepId, stepStateForRound?.first_seq ?? null)
        if (callsBeforeElicit >= CALLS_LIMIT) throw new ApiError(409, `Step ${stepId} đã dùng hết ${CALLS_LIMIT} lượt gọi model`, CALL_LIMIT)

        const elicitUsageId = await meter.reserveCall(projectId, userId, stepId, "elicit")
        let elicitResult: AiActionResult<ElicitOutput>
        try {
          elicitResult = await d.elicitExecutor(
            {
              promptVariables: {
                step_id: stepId,
                step_name: ctx.label_en,
                working_mode: workingMode,
                elicit_turns_this_phase: spine.progress.elicit_turns_this_phase,
                missing: ctx.emptyFields,
                projection: ctx.projection,
                addendum: ctx.addendum,
                content_guidance: "",
                recent_turns: ctx.transcriptTail,
                user_message: "(tự động — vòng elicit đầu step)"
              }
            },
            projectId,
            userId
          )
        } catch (err) {
          await meter.releaseCall(elicitUsageId)
          throw err
        }
        await meter.finalizeCall(elicitUsageId, {
          call_kind: "elicit",
          attempt: 1,
          tokens_in: elicitResult.tokensUsed.promptTokens,
          tokens_out: elicitResult.tokensUsed.completionTokens,
          cost: elicitResult.cost,
          logId: elicitResult.logId || null
        })
        emit({ type: "elicit", step_id: stepId, delta: elicitResult.data.reply })
        await pushTranscript(sessionId, stepId, "ai", elicitResult.data.reply)

        const turnsApplied = await applyTransaction(projectId, {
          base_version: spineVersion,
          ops: [{ op: "set", path: "progress.elicit_turns_this_phase", value: spine.progress.elicit_turns_this_phase + 1 }],
          by: userId,
          step_id: stepId,
          reason: "step-runner: elicit turn"
        })
        spineVersion = turnsApplied.spine_version

        if (elicitResult.data.questions.length > 0) {
          const questions = elicitResult.data.questions.map((q, i) => ({
            id: `Q${i + 1}`,
            text: q.question,
            ...(q.suggestedAnswers.length > 0 ? { options: q.suggestedAnswers } : {}),
            ...(q.multiple !== undefined ? { multiple: q.multiple } : {})
          }))
          emit({ type: "answer_needed", step_id: stepId, questions })
          const answers = await waitForAnswer(projectId, stepId, sessionId, d.signal)
          const answersJoined = answers.map((a) => `${a.question_id}: ${Array.isArray(a.answer) ? a.answer.join(", ") : a.answer}`).join("\n")
          for (const a of answers) await pushTranscript(sessionId, stepId, "user", Array.isArray(a.answer) ? a.answer.join(", ") : a.answer)
          answersText = `${answersText}\n${answersJoined}`.trim()
        }
        ;({ spine, spineVersion } = await refresh(projectId))
      }

      // T18 — S-5.2/S-5.4: màn nhiều function chia thành nhiều lượt Draft ≤ 6 function. Mỗi lượt vẫn
      // tự kiểm trần 8 lượt gọi/step trong `runDraftPhase`; màn quá lớn sẽ dừng ở CALL_LIMIT và user
      // chốt phần đã có ở gate (không có ngoại lệ trần cho vòng lặp).
      for (const batch of functionBatches(spine, stepId)) {
        const current = await refresh(projectId)
        spine = current.spine
        spineVersion = current.spineVersion
        const draftPhase = await runDraftPhase(projectId, stepId, batchContext(ctx, batch), spine, userId, "draft", emit, d, { answers: answersText })
        spineVersion = draftPhase.spineVersion
      }
    }

    spineVersion = await runRenderReviewPhase(projectId, stepId, stepDef.renders, parseStepId(stepId).loop, userId, emit, d)
    await trackSeqRange(projectId, spineVersion, stepId, userId, startSeq, stepStateForRound)

    // Ghép SAU khi cờ đã tính lại và dải seq đã ghi — cache khớp đúng spine_version user nhìn ở gate.
    if (stepDef.template_id === ASSEMBLE_STEP) {
      assertNotAborted(d.signal, stepId)
      await d.assembleDocument(projectId, (await refresh(projectId)).spineVersion)
    }

    const { spine: finalSpine } = await refresh(projectId)
    const finalFirstSeq = finalSpine.steps.find((s) => s.id === stepId)?.first_seq ?? null
    const { calls_used, regenerate_used } = await usageCounts(projectId, stepId, finalFirstSeq)
    const actions: GateAction[] = regenerate_used >= REGENERATE_LIMIT_COUNT ? ["accept", "revision", "accept_as_is"] : ["accept", "revision", "regenerate"]

    emit({ type: "gate_ready", step_id: stepId, actions, regenerate_used, calls_used })
  } finally {
    releaseStepLock(projectId, stepId)
  }
}

/** Mã lỗi pipeline hợp lệ — controller dùng để quyết định phát SSE `error` hay để nguyên lỗi HTTP thường. */
export const isPipelineErrorCode = (code: string): code is PipelineErrorCode => code in PIPELINE_ERROR_STATUS
