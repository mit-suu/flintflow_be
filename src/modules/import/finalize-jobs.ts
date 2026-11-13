/**
 * Finalize (nút 1.10–1.12) chạy nền — cùng cách với I-4 (`extract-jobs.ts`). SRS ~200 trang: tách lại file, áp Spine, vẽ
 * mọi diagram, render bản 0.1, chụp baseline rồi 1.11 (nhiều lượt AI) mất vài phút; reverse proxy (60–100 s) cắt request
 * trong khi BE vẫn chạy, lần bấm lại gặp `IMPORT_INVALID_STATE`. Vì vậy:
 *   - `POST /import/finalize` kiểm điều kiện **ngay** (trạng thái, `base_version`, profile — lỗi 4xx như cũ), ghi mốc
 *     (`finalize_checkpoint`) rồi trả ngay import `baselining`; FE poll `GET /import` tới `gap_review` hoặc `paused`.
 *   - `POST /import/resume` ở `checking` (1.11–1.12) và ở `baselining` đã có mốc (chạy lại finalize) cũng chạy nền.
 *   - Gọi lại khi đang có job = không làm gì, trả trạng thái hiện tại. Mỗi import tối đa một job (khoá `finalize-<id>`).
 *   - Job đi qua queue `import` (`shared/queue/`, docs/background-jobs.md). Lỗi tạm thời ⇒ retry đúng như người dùng
 *     bấm "Tiếp tục": `baselining` ⇒ hoàn về mốc rồi finalize lại; `checking` ⇒ 1.11–1.12 phần còn thiếu (lượt AI đã trừ
 *     credit không gọi lại). Worker chết giữa chừng ⇒ job stalled, worker khác nhận chạy lại.
 *   - Hết lượt retry: ở `baselining` ⇒ hoàn về mốc (`rollbackPartialFinalize`) + `paused: resume_later`; ở `checking`
 *     ⇒ `paused: resume_later`.
 *   - Không còn job (driver inline mất job khi khởi động lại) ⇒ lần đọc `GET /import` kế tiếp thấy `baselining` (có mốc) /
 *     `checking` mà không có job ⇒ `paused: resume_later`; resume hoàn phần dở về mốc rồi chạy lại.
 *   - FLF-391 — job còn trong queue nhưng không chạy tiếp (treo trong tiến trình sống, hoặc tiến trình chết mà chưa có worker
 *     dọn job stalled) trước đây làm import kẹt `baselining` vô hạn. Nay:
 *       · lần chạy quá `FINALIZE_IDLE_TIMEOUT_MS` không tiến thêm (bước finalize, lượt AI kiểm tra, diagram) ⇒ lỗi tạm thời ⇒
 *         retry / `paused`; lần chạy chậm mà vẫn tiến thì không bị cắt;
 *       · lần chạy đập nhịp tim (`finalize_heartbeat_at`) mỗi `FINALIZE_HEARTBEAT_MS`; job `active` mà nhịp tim cũ hơn
 *         `FINALIZE_STALE_MS` ⇒ coi là mất (gắn `paused`, resume gỡ khoá job cũ rồi chạy lần mới);
 *       · mỗi lần bật job có mã riêng (`finalize_run_id`, lần thử n > 1: `<mã>#n`; hết giờ ⇒ mã bị vô hiệu ngay); lần chạy cũ
 *         thấy mã lệch ⇒ dừng ở bước / lượt AI kế tiếp, không ghi đè, không chạy chồng với lần thử lại.
 */

import { randomUUID } from "node:crypto"
import { UnrecoverableError } from "bullmq"
import { env } from "../../config/env.js"
import { defineJob, isJobActive, jobState, releaseJobKey, startJob, waitForJob } from "../../shared/queue/job-runner.js"
import * as spineRepository from "../spine/spine.repository.js"
import { finalizeCheckpoint, finalizeImport, resumeCheck, rollbackPartialFinalize, assertCanFinalize, type FinalizeRunOptions } from "./finalize.service.js"
import type { FinalizeRequest } from "./import.dto.js"
import { assertImportStatus, requireImport, transitionImport } from "./import.service.js"
import { canPause } from "./import.state.js"
import { ImportedDocument, type IImportedDocument } from "./imported-document.model.js"
import { Mode1Error } from "./mode1.errors.js"

interface FinalizeJobData {
  /** `finalize` = 1.10–1.12 từ mốc; `check` = 1.11–1.12 phần còn thiếu (import ở `checking`). */
  mode: "finalize" | "check"
  projectId: string
  userId: string
  importId: string
  /** Mã lần chạy (FLF-391). Job tạo trước khi có cơ chế này không có ⇒ không kiểm mã. */
  runId?: string
}

const jobKey = (importId: string) => `finalize-${importId}`

/** Mã của một lần thử: lần đầu = mã job, lần thử n > 1 = `<mã job>#n` (lần thử trước hết giờ không chạy chồng với lần sau). */
const attemptToken = (runId: string | undefined, attempt: number): string | undefined => (runId && attempt > 1 ? `${runId}#${attempt}` : runId)

/** Mã đang ghi trên import thuộc job `runId` (mọi lần thử của nó) — chưa bị resume thay bằng job mới. */
const ownedByJob = (current: string | null | undefined, runId: string): boolean => !current || current === runId || current.startsWith(`${runId}#`)

const currentRunId = async (importId: string): Promise<string | null | undefined> =>
  (await ImportedDocument.findById(importId).select("finalize_run_id").lean())?.finalize_run_id

/** Lần thử `token` còn là lần hiện hành của import không (chưa hết giờ, chưa bị lần thử sau / job mới thay). */
const isCurrentRun = async (importId: string, token: string | undefined): Promise<boolean> => {
  if (!token) return true
  const current = await currentRunId(importId)
  return !current || current === token
}

/** Ghi mã lần chạy + nhịp tim đầu (gọi trong `prepare`, trước khi trả lời client). */
const claimRun = (doc: IImportedDocument, runId: string | undefined): void => {
  if (!runId) return
  doc.finalize_run_id = runId
  doc.finalize_heartbeat_at = new Date()
}

/** Nhịp tim: chỉ ghi khi lần chạy còn hiện hành; không đổi `updatedAt` (không phải thay đổi nghiệp vụ). */
const heartbeat = (importId: string, runId: string | undefined): Promise<unknown> =>
  ImportedDocument.updateOne(runId ? { _id: importId, finalize_run_id: runId } : { _id: importId }, { $set: { finalize_heartbeat_at: new Date() } }, { timestamps: false }).catch(
    () => undefined
  )

/**
 * Job đang `active` mà nhịp tim (bản ghi cũ chưa có nhịp tim: lần cập nhật cuối) cũ hơn `FINALIZE_STALE_MS` ⇒ coi là mất.
 * Đọc lại từ DB: bản ghi trong tay người gọi có thể được đọc trước nhịp tim đầu của job vừa nhận.
 */
const isStale = async (importId: string): Promise<boolean> => {
  const fresh = await ImportedDocument.findById(importId).select("finalize_heartbeat_at updatedAt").lean()
  const beat = fresh?.finalize_heartbeat_at ?? fresh?.updatedAt
  return !beat || Date.now() - new Date(beat).getTime() > env.FINALIZE_STALE_MS
}

/** Job lỗi ⇒ trạng thái nhất quán để chạy lại: hoàn phần finalize dở (nếu còn `baselining`), rồi `resume_later`. */
const pauseAfterFailure = async (importId: string, runId: string | undefined): Promise<void> => {
  const doc = await ImportedDocument.findById(importId)
  if (!doc || !canPause(doc.status)) return
  // Job cũ đã bị resume thay: job mới đang giữ import — không hoàn, không dừng thay nó
  if (runId && !ownedByJob(doc.finalize_run_id, runId)) return
  // Hoàn lỗi thì vẫn dừng: resume hoàn lại từ cùng mốc trước khi chạy (revert cả dải kể cả lô revert dở ⇒ vẫn về mốc)
  await rollbackPartialFinalize(doc).catch((err: unknown) => console.error(`[finalize] Hoàn lần finalize dở của import ${importId} lỗi:`, err))
  doc.paused = { reason: "resume_later", at: new Date() }
  await doc.save()
}

/** Hoàn phần dở của lần trước (nếu có), ghi mốc mới, bỏ `paused`, nhận lần chạy — rồi mới chạy finalize. */
const prepareFinalize = (doc: IImportedDocument, recordOfChanges: FinalizeRequest["record_of_changes"] | null, runId: string | undefined) => async () => {
  await rollbackPartialFinalize(doc)
  doc.finalize_checkpoint = await finalizeCheckpoint(String(doc.projectId), recordOfChanges)
  doc.paused = null
  claimRun(doc, runId)
  await doc.save()
}

/** Kiểm tra 1.11–1.12: chỉ bỏ `paused` và nhận lần chạy. */
const prepareCheck = (doc: IImportedDocument, runId: string | undefined) => async () => {
  doc.paused = null
  claimRun(doc, runId)
  await doc.save()
}

/** Finalize với `base_version` = Spine sau khi hoàn (đã kiểm `base_version` của client lúc nhận request). */
const runFinalize = async (projectId: string, userId: string, importId: string, run: FinalizeRunOptions): Promise<void> => {
  const doc = await requireImport(projectId, importId)
  const spine = await spineRepository.get(projectId)
  const recordOfChanges = doc.finalize_checkpoint?.record_of_changes ?? undefined
  await finalizeImport(projectId, userId, { import_id: importId, base_version: spine?.spine_version ?? 0, ...(recordOfChanges ? { record_of_changes: recordOfChanges } : {}) }, run)
}

/** Một lượt chạy (lần đầu hoặc retry). */
const runAttempt = async ({ mode, projectId, userId, importId }: FinalizeJobData, attempt: number, token: string | undefined, run: FinalizeRunOptions): Promise<void> => {
  const doc = await requireImport(projectId, importId)
  // Lần thử lại: làm đúng như `startResume` — lần trước có thể đã qua 1.10 (sang `checking`) hoặc dừng giữa `baselining`
  if (mode === "check" || (attempt > 1 && doc.status === "checking")) {
    if (attempt > 1) {
      claimRun(doc, token)
      await doc.save()
    }
    await resumeCheck(doc, userId, run)
    return
  }
  if (attempt > 1) await prepareFinalize(doc, doc.finalize_checkpoint?.record_of_changes ?? null, token)()
  await runFinalize(projectId, userId, importId, run)
}

const finalizeJob = defineJob<FinalizeJobData>({
  queue: "import",
  name: "finalize",
  options: { attempts: 2, backoff: { type: "exponential", delay: 30_000 } },
  process: async (data, { attempt }) => {
    const { importId, runId } = data
    // Job cũ được worker nhận lại sau khi đã bị resume thay bằng job mới ⇒ bỏ qua (không lỗi, không đụng import)
    if (runId && !ownedByJob(await currentRunId(importId), runId)) return
    const token = attemptToken(runId, attempt)
    let expired = false
    let idleTimer: NodeJS.Timeout | undefined
    let rejectIdle!: (err: Error) => void
    const idle = new Promise<never>((_, reject) => (rejectIdle = reject))
    const expire = (): void => {
      expired = true
      // Vô hiệu mã ngay: lượt bị bỏ lại dừng ở guard kế tiếp kể cả khi lần thử sau đã chạy — không chạy chồng, không trừ credit
      // hai lần. Mã mới vẫn thuộc job (`<mã>#…`) nên xử lý lỗi cuối của chính job này vẫn hoàn / dừng được
      if (token) void ImportedDocument.updateOne({ _id: importId, finalize_run_id: token }, { $set: { finalize_run_id: `${token}#expired` } }, { timestamps: false }).catch(() => undefined)
      rejectIdle(new Error(`Job finalize của import ${importId} quá ${env.FINALIZE_IDLE_TIMEOUT_MS} ms không tiến thêm`))
    }
    /** Còn tiến triển ⇒ đặt lại đồng hồ đứng im. */
    const progress = (): void => {
      if (expired) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(expire, env.FINALIZE_IDLE_TIMEOUT_MS)
    }
    const guard = async (): Promise<void> => {
      if (expired) throw new Error(`Lần chạy finalize của import ${importId} đã quá giờ`)
      if (!(await isCurrentRun(importId, token))) throw new UnrecoverableError(`Lần chạy finalize của import ${importId} đã được thay bằng lần mới`)
      progress()
    }
    // Nhịp tim đầu ngay khi nhận job (lần thử lại: mã còn của lần trước tới khi `runAttempt` ghi mã mới)
    await heartbeat(importId, attempt > 1 ? undefined : token)
    progress()
    const beating = setInterval(() => void heartbeat(importId, token), env.FINALIZE_HEARTBEAT_MS)
    const work = runAttempt(data, attempt, token, { guard, progress })
    // Hết giờ thì lượt này bị bỏ lại, dừng ở `guard` kế tiếp — lỗi của nó lúc đó không còn ai chờ
    work.catch(() => undefined)
    try {
      await Promise.race([work, idle])
    } finally {
      clearInterval(beating)
      clearTimeout(idleTimer)
    }
  },
  onFinalFailure: async ({ importId, runId }, err) => {
    console.error(`[finalize] Job finalize / kiểm tra của import ${importId} lỗi:`, err)
    await pauseAfterFailure(importId, runId).catch((e: unknown) => console.error(`[finalize] Không đặt được trạng thái dừng cho import ${importId}:`, e))
  }
})

/** Có job finalize / kiểm tra của import trong queue không (kể cả job kẹt — dùng `isFinalizeAlive` để biết còn chạy tiếp). */
export const isFinalizeRunning = (importId: string): Promise<boolean> => isJobActive(finalizeJob, jobKey(importId))

/** Job còn sống: đang chờ / chờ retry, hoặc đang chạy mà nhịp tim chưa cũ. Job `active` hết nhịp tim = job mất. */
export const isFinalizeAlive = async (doc: IImportedDocument): Promise<boolean> => {
  const state = await jobState(finalizeJob, jobKey(String(doc._id)))
  if (!state) return false
  return state !== "active" || !(await isStale(String(doc._id)))
}

/**
 * Sinh mã lần chạy, gỡ khoá job cũ còn kẹt (người gọi đã kiểm nó không còn sống), rồi bật job. `prepare` chạy và được chờ
 * trước khi trả lời (bỏ `paused`, ghi mốc, nhận lần chạy) để lần poll đầu không thấy trạng thái cũ.
 */
const launch = async (
  doc: IImportedDocument,
  data: Omit<FinalizeJobData, "runId">,
  makePrepare: (runId: string) => () => Promise<void>
): Promise<IImportedDocument> => {
  const key = jobKey(data.importId)
  // Tới đây mà còn job thì chỉ có thể là job `active` hết nhịp tim (người gọi đã trả trước khi job đang chờ / chạy bình thường)
  if ((await jobState(finalizeJob, key)) === "active") await releaseJobKey(finalizeJob, key)
  const runId = randomUUID()
  await startJob(finalizeJob, { ...data, runId }, { key, prepare: makePrepare(runId) })
  return doc
}

/** `POST /import/finalize`: kiểm điều kiện (4xx trả ngay) rồi chạy finalize nền. Trả bản ghi import hiện tại. */
export const startFinalize = async (projectId: string, userId: string, body: FinalizeRequest): Promise<IImportedDocument> => {
  const current = await requireImport(projectId, body.import_id)
  if (await isFinalizeAlive(current)) return current
  const { doc } = await assertCanFinalize(projectId, body)
  // D4 (quyết định 26/09): file thiếu cấu trúc đích không có bản gốc 0.1 — không còn "Hoàn thiện" (`complete: true`) từ
  // `incomplete`. Giữ khung lẫn bổ sung theo mẫu chuẩn (FLF-416) ⇒ soạn phần thiếu ở Luồng 2 (`POST /import/continue`)
  if (doc.status === "incomplete") {
    throw new Mode1Error(
      "IMPORT_INVALID_STATE",
      "File còn thiếu mục của cấu trúc đích nên chưa tạo được bản gốc - soạn phần còn thiếu với FlintFlow.",
      { status: doc.status, to: "drafting", allowed: ["drafting"] }
    )
  }
  // request song song vừa bật job trong lúc kiểm ⇒ `startJob` không chạy lần hai
  return launch(doc, { mode: "finalize", projectId, userId, importId: body.import_id }, (runId) => prepareFinalize(doc, body.record_of_changes ?? null, runId))
}

/**
 * FLF-343 (một mạch): job I-4 xong ⇒ finalize nền ngay, không chờ người dùng bấm. `base_version` = Spine hiện tại (server
 * tính), Record of Changes đọc từ file (`record_of_changes` của mốc = null). Đang có job ⇒ không làm gì.
 */
export const startAutoFinalize = async (projectId: string, userId: string, importId: string): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, importId)
  if (await isFinalizeAlive(doc)) return doc
  assertImportStatus(doc, ["baselining"], "checking")
  return launch(doc, { mode: "finalize", projectId, userId, importId }, (runId) => prepareFinalize(doc, null, runId))
}

/**
 * `POST /import/resume` cho bước sau trích field: `checking` ⇒ 1.11–1.12 phần còn thiếu; `baselining` có mốc (job
 * finalize lỗi / mất / kẹt) ⇒ hoàn về mốc rồi chạy lại finalize; `baselining` chưa có mốc (FLF-343: job nối tiếp chưa kịp bật)
 * hoặc bản ghi cũ ở `fields_review` ⇒ finalize một mạch. Đang có job còn sống ⇒ không làm gì.
 */
export const startResume = async (projectId: string, userId: string, importId: string): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, importId)
  if (await isFinalizeAlive(doc)) return doc
  if (doc.status === "fields_review") await transitionImport(doc, "baselining")
  assertImportStatus(doc, ["baselining", "checking"], doc.status === "baselining" ? "checking" : "gap_review")
  if (doc.status === "checking") return launch(doc, { mode: "check", projectId, userId, importId }, (runId) => prepareCheck(doc, runId))
  if (!doc.finalize_checkpoint) return startAutoFinalize(projectId, userId, importId)
  const recordOfChanges = doc.finalize_checkpoint.record_of_changes ?? null
  return launch(doc, { mode: "finalize", projectId, userId, importId }, (runId) => prepareFinalize(doc, recordOfChanges, runId))
}

/**
 * Import đang `baselining` hoặc `checking`, không dừng, mà job không còn sống (không có trong queue, hoặc `active` mà hết
 * nhịp tim — FLF-391) ⇒ job đã mất. Đánh dấu `paused: resume_later` để người dùng bấm tiếp tục. FLF-343: `baselining` chưa
 * có mốc cũng tính (job finalize nối tiếp I-4 không bật được, hoặc bản ghi cũ chờ bấm tạo baseline) — trừ lúc job I-4 vừa
 * xong còn đang bật finalize.
 */
export const markOrphanedFinalize = async (doc: IImportedDocument): Promise<void> => {
  if (doc.paused) return
  if (doc.status !== "checking" && doc.status !== "baselining") return
  if (await isFinalizeAlive(doc)) return
  if (doc.status === "baselining" && !doc.finalize_checkpoint) {
    const { isExtractionRunning } = await import("./extract-jobs.js")
    if (await isExtractionRunning(String(doc._id))) return
  }
  doc.paused = { reason: "resume_later", at: new Date() }
  await doc.save()
}

/** Chờ job finalize / kiểm tra của một import chạy xong (test, script đo, chạy tiếp sau khi nạp credit). */
export const waitForFinalize = (importId: string): Promise<void> => waitForJob(finalizeJob, jobKey(importId))
