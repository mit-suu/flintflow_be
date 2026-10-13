/**
 * Finalize (nút 1.10–1.12) chạy nền — cùng cách với I-4 (`extract-jobs.ts`). SRS ~200 trang: tách lại file, áp Spine, vẽ
 * mọi diagram, render bản 0.0, chụp baseline rồi 1.11 (nhiều lượt AI) mất vài phút; reverse proxy (60–100 s) cắt request
 * trong khi BE vẫn chạy, lần bấm lại gặp `IMPORT_INVALID_STATE`. Vì vậy:
 *   - `POST /import/finalize` kiểm điều kiện **ngay** (trạng thái, `base_version`, profile — lỗi 4xx như cũ), ghi mốc
 *     (`finalize_checkpoint`) rồi trả ngay import `baselining`; FE poll `GET /import` tới `gap_review` hoặc `paused`.
 *   - `POST /import/resume` ở `checking` (1.11–1.12) và ở `baselining` đã có mốc (chạy lại finalize) cũng chạy nền.
 *   - Gọi lại khi job đang chạy = không làm gì, trả trạng thái hiện tại. Mỗi import tối đa một job trong tiến trình.
 *   - Job lỗi ngoài dự kiến: ở `baselining` ⇒ hoàn về mốc (`rollbackPartialFinalize`) + `paused: resume_later`; ở
 *     `checking` ⇒ `paused: resume_later` (lượt AI đã trừ credit không gọi lại khi resume).
 *   - Máy chủ khởi động lại giữa chừng ⇒ lần đọc `GET /import` kế tiếp thấy `baselining` (có mốc) / `checking` mà không có
 *     job ⇒ `paused: resume_later`; resume hoàn phần dở về mốc rồi chạy lại. Giả định một instance BE.
 */

import * as spineRepository from "../spine/spine.repository.js"
import { finalizeCheckpoint, finalizeImport, resumeCheck, rollbackPartialFinalize, assertCanFinalize } from "./finalize.service.js"
import type { FinalizeRequest } from "./import.dto.js"
import { assertImportStatus, requireImport } from "./import.service.js"
import { canPause } from "./import.state.js"
import { ImportedDocument, type IImportedDocument } from "./imported-document.model.js"
import { Mode1Error } from "./mode1.errors.js"

const running = new Map<string, Promise<void>>()

export const isFinalizeRunning = (importId: string): boolean => running.has(importId)

/** Job lỗi ⇒ trạng thái nhất quán để chạy lại: hoàn phần finalize dở (nếu còn `baselining`), rồi `resume_later`. */
const pauseAfterFailure = async (importId: string): Promise<void> => {
  const doc = await ImportedDocument.findById(importId)
  if (!doc || !canPause(doc.status)) return
  // Hoàn lỗi thì vẫn dừng: resume hoàn lại từ cùng mốc trước khi chạy (revert cả dải kể cả lô revert dở ⇒ vẫn về mốc)
  await rollbackPartialFinalize(doc).catch((err: unknown) => console.error(`[finalize] Hoàn lần finalize dở của import ${importId} lỗi:`, err))
  doc.paused = { reason: "resume_later", at: new Date() }
  await doc.save()
}

/**
 * Đăng ký job NGAY (không `await` xen giữa lần kiểm `running` và `set`) để hai request đồng thời không cùng chạy.
 * `prepare` chạy trước `work` và được chờ trước khi trả lời (bỏ `paused`, ghi mốc) để lần poll đầu không thấy trạng thái cũ.
 */
const launch = async (doc: IImportedDocument, prepare: () => Promise<void>, work: () => Promise<unknown>): Promise<IImportedDocument> => {
  const importId = String(doc._id)
  const prepared = prepare()
  const job = prepared
    .then(work)
    .then(() => undefined)
    .catch(async (err: unknown) => {
      console.error(`[finalize] Job finalize / kiểm tra của import ${importId} lỗi:`, err)
      await pauseAfterFailure(importId).catch((e: unknown) => console.error(`[finalize] Không đặt được trạng thái dừng cho import ${importId}:`, e))
    })
    .finally(() => running.delete(importId))
  running.set(importId, job)
  await prepared.catch(() => undefined) // lỗi đã đi vào job (⇒ paused); client poll thấy
  return doc
}

/** Hoàn phần dở của lần trước (nếu có), ghi mốc mới, bỏ `paused` — rồi mới chạy finalize. */
const prepareFinalize = (doc: IImportedDocument, recordOfChanges: FinalizeRequest["record_of_changes"] | null) => async () => {
  await rollbackPartialFinalize(doc)
  doc.finalize_checkpoint = await finalizeCheckpoint(String(doc.projectId), recordOfChanges)
  doc.paused = null
  await doc.save()
}

/** Finalize với `base_version` = Spine sau khi hoàn (đã kiểm `base_version` của client lúc nhận request). */
const runFinalize = (projectId: string, userId: string, importId: string) => async () => {
  const doc = await requireImport(projectId, importId)
  const spine = await spineRepository.get(projectId)
  const recordOfChanges = doc.finalize_checkpoint?.record_of_changes ?? undefined
  await finalizeImport(projectId, userId, { import_id: importId, base_version: spine?.spine_version ?? 0, ...(recordOfChanges ? { record_of_changes: recordOfChanges } : {}) })
}

/** `POST /import/finalize`: kiểm điều kiện (4xx trả ngay) rồi chạy finalize nền. Trả bản ghi import hiện tại. */
export const startFinalize = async (projectId: string, userId: string, body: FinalizeRequest): Promise<IImportedDocument> => {
  const current = await requireImport(projectId, body.import_id)
  if (running.has(body.import_id)) return current
  const { doc } = await assertCanFinalize(projectId, body)
  if (running.has(body.import_id)) return doc // request song song vừa bật job trong lúc kiểm
  return launch(doc, prepareFinalize(doc, body.record_of_changes ?? null), runFinalize(projectId, userId, body.import_id))
}

/**
 * `POST /import/resume` cho bước sau trích field: `checking` ⇒ 1.11–1.12 phần còn thiếu; `baselining` có mốc (job
 * finalize lỗi / mất) ⇒ hoàn về mốc rồi chạy lại finalize. Đang chạy ⇒ không làm gì.
 */
export const startResume = async (projectId: string, userId: string, importId: string): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, importId)
  if (running.has(importId)) return doc
  assertImportStatus(doc, ["baselining", "checking"], doc.status === "baselining" ? "checking" : "gap_review")
  if (doc.status === "checking") {
    const prepare = async () => {
      doc.paused = null
      await doc.save()
    }
    return launch(doc, prepare, () => resumeCheck(doc, userId))
  }
  if (!doc.finalize_checkpoint) {
    throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa bắt đầu tạo bản gốc — hãy bấm tạo baseline 0.0", { status: doc.status, to: "checking", allowed: ["checking"] })
  }
  return launch(doc, prepareFinalize(doc, doc.finalize_checkpoint.record_of_changes ?? null), runFinalize(projectId, userId, importId))
}

/**
 * Import đang `baselining` (đã bắt đầu finalize) hoặc `checking`, không dừng, mà tiến trình này không có job ⇒ job đã mất
 * (máy chủ khởi động lại). Đánh dấu `paused: resume_later` để người dùng bấm tiếp tục.
 */
export const markOrphanedFinalize = async (doc: IImportedDocument): Promise<void> => {
  if (doc.paused || running.has(String(doc._id))) return
  if (doc.status !== "checking" && !(doc.status === "baselining" && doc.finalize_checkpoint)) return
  doc.paused = { reason: "resume_later", at: new Date() }
  await doc.save()
}

/** Chờ job finalize / kiểm tra của một import chạy xong (test, script đo, chạy tiếp sau khi nạp credit). */
export const waitForFinalize = async (importId: string): Promise<void> => {
  await running.get(importId)
}
