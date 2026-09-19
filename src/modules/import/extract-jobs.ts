/**
 * I-4 chạy nền (việc A sau P2, FLF-171): SRS đầy đủ cần vài phút gọi AI — không giữ một request HTTP chờ.
 * `POST /import/extract` và `/import/resume` kiểm trạng thái rồi trả ngay (`status = extracting`, `paused = null`);
 * FE poll `GET /import` xem từng section. Job xong ⇒ import sang `fields_review` / `baselining`, hoặc `paused`.
 *
 * Mỗi import tối đa một job trong tiến trình (gọi lại khi đang chạy = không làm gì). Máy chủ khởi động lại giữa
 * chừng ⇒ job mất: lần đọc `GET /import` kế tiếp thấy `extracting` mà không có job ⇒ đặt `paused: resume_later`
 * để FE hiện nút "Tiếp tục" (section đã `done` không trích lại nhờ `extract_cursor`). Giả định một instance BE.
 */

import { ImportedDocument, type IImportedDocument } from "./imported-document.model.js"
import { assertImportStatus, requireImport } from "./import.service.js"
import { runExtraction } from "./extract.service.js"

const running = new Map<string, Promise<void>>()

export const isExtractionRunning = (importId: string): boolean => running.has(importId)

/** Kiểm điều kiện (lỗi trạng thái trả ngay cho client) rồi chạy I-4 nền. Trả bản ghi import hiện tại. */
export const startExtraction = async (projectId: string, userId: string, importId: string): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, importId)
  assertImportStatus(doc, ["extracting"], "extracting")
  if (running.has(importId)) return doc

  // Đăng ký job NGAY sau khi kiểm (không `await` xen giữa) để hai request đồng thời không cùng chạy.
  // Bỏ `paused` trước khi trả lời để lần poll đầu không thấy trạng thái dừng cũ.
  const cleared = ImportedDocument.updateOne({ _id: importId }, { $set: { paused: null } }).exec()
  const job = cleared
    .then(() => runExtraction(projectId, userId, importId))
    .then(() => undefined)
    .catch(async (err: unknown) => {
      console.error(`[I-4] Job trích field của import ${importId} lỗi:`, err)
      await ImportedDocument.updateOne({ _id: importId, status: "extracting" }, { $set: { paused: { reason: "resume_later", at: new Date() } } }).catch(
        () => undefined
      )
    })
    .finally(() => running.delete(importId))
  running.set(importId, job)
  await cleared
  doc.paused = null
  return doc
}

/**
 * Import đang `extracting`, không dừng, mà tiến trình này không có job ⇒ job đã mất (máy chủ khởi động lại).
 * Đánh dấu `paused: resume_later` để người dùng bấm tiếp tục.
 */
export const markOrphanedExtraction = async (doc: IImportedDocument): Promise<void> => {
  if (doc.status !== "extracting" || doc.paused || running.has(String(doc._id))) return
  if (!doc.extract_cursor) return // chưa từng chạy (vừa xác nhận mapping) — không phải job mất
  doc.paused = { reason: "resume_later", at: new Date() }
  await doc.save()
}

/** Chờ job của một import chạy xong (test, script đo). */
export const waitForExtraction = async (importId: string): Promise<void> => {
  await running.get(importId)
}
