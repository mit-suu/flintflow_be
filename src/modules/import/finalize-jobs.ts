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
 */

import { defineJob, isJobActive, startJob, waitForJob } from "../../shared/queue/job-runner.js"
import * as spineRepository from "../spine/spine.repository.js"
import { finalizeCheckpoint, finalizeImport, resumeCheck, rollbackPartialFinalize, assertCanFinalize } from "./finalize.service.js"
import type { FinalizeRequest } from "./import.dto.js"
import { assertImportStatus, requireImport } from "./import.service.js"
import { canPause } from "./import.state.js"
import { ImportedDocument, type IImportedDocument } from "./imported-document.model.js"
import { Mode1Error } from "./mode1.errors.js"

interface FinalizeJobData {
  /** `finalize` = 1.10–1.12 từ mốc; `check` = 1.11–1.12 phần còn thiếu (import ở `checking`). */
  mode: "finalize" | "check"
  projectId: string
  userId: string
  importId: string
}

const jobKey = (importId: string) => `finalize-${importId}`

/** Job lỗi ⇒ trạng thái nhất quán để chạy lại: hoàn phần finalize dở (nếu còn `baselining`), rồi `resume_later`. */
const pauseAfterFailure = async (importId: string): Promise<void> => {
  const doc = await ImportedDocument.findById(importId)
  if (!doc || !canPause(doc.status)) return
  // Hoàn lỗi thì vẫn dừng: resume hoàn lại từ cùng mốc trước khi chạy (revert cả dải kể cả lô revert dở ⇒ vẫn về mốc)
  await rollbackPartialFinalize(doc).catch((err: unknown) => console.error(`[finalize] Hoàn lần finalize dở của import ${importId} lỗi:`, err))
  doc.paused = { reason: "resume_later", at: new Date() }
  await doc.save()
}

/** Hoàn phần dở của lần trước (nếu có), ghi mốc mới, bỏ `paused` — rồi mới chạy finalize. */
const prepareFinalize = (doc: IImportedDocument, recordOfChanges: FinalizeRequest["record_of_changes"] | null) => async () => {
  await rollbackPartialFinalize(doc)
  doc.finalize_checkpoint = await finalizeCheckpoint(String(doc.projectId), recordOfChanges)
  doc.paused = null
  await doc.save()
}

/** Finalize với `base_version` = Spine sau khi hoàn (đã kiểm `base_version` của client lúc nhận request). */
const runFinalize = async (projectId: string, userId: string, importId: string): Promise<void> => {
  const doc = await requireImport(projectId, importId)
  const spine = await spineRepository.get(projectId)
  const recordOfChanges = doc.finalize_checkpoint?.record_of_changes ?? undefined
  await finalizeImport(projectId, userId, { import_id: importId, base_version: spine?.spine_version ?? 0, ...(recordOfChanges ? { record_of_changes: recordOfChanges } : {}) })
}

const finalizeJob = defineJob<FinalizeJobData>({
  queue: "import",
  name: "finalize",
  options: { attempts: 2, backoff: { type: "exponential", delay: 30_000 } },
  process: async ({ mode, projectId, userId, importId }, { attempt }) => {
    const doc = await requireImport(projectId, importId)
    // Lần thử lại: làm đúng như `startResume` — lần trước có thể đã qua 1.10 (sang `checking`) hoặc dừng giữa `baselining`
    if (mode === "check" || (attempt > 1 && doc.status === "checking")) {
      await resumeCheck(doc, userId)
      return
    }
    if (attempt > 1) await prepareFinalize(doc, doc.finalize_checkpoint?.record_of_changes ?? null)()
    await runFinalize(projectId, userId, importId)
  },
  onFinalFailure: async ({ importId }, err) => {
    console.error(`[finalize] Job finalize / kiểm tra của import ${importId} lỗi:`, err)
    await pauseAfterFailure(importId).catch((e: unknown) => console.error(`[finalize] Không đặt được trạng thái dừng cho import ${importId}:`, e))
  }
})

export const isFinalizeRunning = (importId: string): Promise<boolean> => isJobActive(finalizeJob, jobKey(importId))

/** `prepare` chạy và được chờ trước khi trả lời (bỏ `paused`, ghi mốc) để lần poll đầu không thấy trạng thái cũ. */
const launch = async (doc: IImportedDocument, data: FinalizeJobData, prepare: () => Promise<void>): Promise<IImportedDocument> => {
  await startJob(finalizeJob, data, { key: jobKey(data.importId), prepare })
  return doc
}

/** `POST /import/finalize`: kiểm điều kiện (4xx trả ngay) rồi chạy finalize nền. Trả bản ghi import hiện tại. */
export const startFinalize = async (projectId: string, userId: string, body: FinalizeRequest): Promise<IImportedDocument> => {
  const current = await requireImport(projectId, body.import_id)
  if (await isFinalizeRunning(body.import_id)) return current
  const { doc } = await assertCanFinalize(projectId, body)
  // request song song vừa bật job trong lúc kiểm ⇒ `startJob` không chạy lần hai
  return launch(doc, { mode: "finalize", projectId, userId, importId: body.import_id }, prepareFinalize(doc, body.record_of_changes ?? null))
}

/**
 * `POST /import/resume` cho bước sau trích field: `checking` ⇒ 1.11–1.12 phần còn thiếu; `baselining` có mốc (job
 * finalize lỗi / mất) ⇒ hoàn về mốc rồi chạy lại finalize. Đang có job ⇒ không làm gì.
 */
export const startResume = async (projectId: string, userId: string, importId: string): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, importId)
  if (await isFinalizeRunning(importId)) return doc
  assertImportStatus(doc, ["baselining", "checking"], doc.status === "baselining" ? "checking" : "gap_review")
  if (doc.status === "checking") {
    const prepare = async () => {
      doc.paused = null
      await doc.save()
    }
    return launch(doc, { mode: "check", projectId, userId, importId }, prepare)
  }
  if (!doc.finalize_checkpoint) {
    throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa bắt đầu tạo bản gốc — hãy bấm tạo baseline 0.1", { status: doc.status, to: "checking", allowed: ["checking"] })
  }
  return launch(doc, { mode: "finalize", projectId, userId, importId }, prepareFinalize(doc, doc.finalize_checkpoint.record_of_changes ?? null))
}

/**
 * Import đang `baselining` (đã bắt đầu finalize) hoặc `checking`, không dừng, mà không có job ⇒ job đã mất. Đánh dấu
 * `paused: resume_later` để người dùng bấm tiếp tục.
 */
export const markOrphanedFinalize = async (doc: IImportedDocument): Promise<void> => {
  if (doc.paused) return
  if (doc.status !== "checking" && !(doc.status === "baselining" && doc.finalize_checkpoint)) return
  if (await isFinalizeRunning(String(doc._id))) return
  doc.paused = { reason: "resume_later", at: new Date() }
  await doc.save()
}

/** Chờ job finalize / kiểm tra của một import chạy xong (test, script đo, chạy tiếp sau khi nạp credit). */
export const waitForFinalize = (importId: string): Promise<void> => waitForJob(finalizeJob, jobKey(importId))
