/**
 * I-4 chạy nền (việc A sau P2, FLF-171): SRS đầy đủ cần vài phút gọi AI — không giữ một request HTTP chờ.
 * `POST /import/extract` và `/import/resume` kiểm trạng thái rồi trả ngay (`status = extracting`, `paused = null`);
 * FE poll `GET /import` xem từng section. Job xong ⇒ import sang `fields_review` / `baselining`, hoặc `paused`.
 *
 * Job đi qua queue `import` (`shared/queue/`, docs/background-jobs.md); mỗi import tối đa một job (khoá `extract-<id>`,
 * gọi lại khi đang có job = không làm gì). Driver bullmq: job nằm trong Redis nên máy chủ / worker khởi động lại giữa
 * chừng thì worker khác nhận chạy tiếp (section đã `done` không trích lại nhờ `extract_cursor`), lỗi tạm thời được retry.
 * Hết lượt retry, hoặc driver inline mất job khi khởi động lại ⇒ lần đọc `GET /import` kế tiếp thấy `extracting` mà
 * không có job ⇒ đặt `paused: resume_later` để FE hiện nút "Tiếp tục".
 */

import { defineJob, isJobActive, startJob, waitForJob } from "../../shared/queue/job-runner.js"
import { ImportedDocument, type IImportedDocument } from "./imported-document.model.js"
import { assertImportStatus, requireImport } from "./import.service.js"
import { runExtraction } from "./extract.service.js"

interface ExtractJobData {
  projectId: string
  userId: string
  importId: string
}

const jobKey = (importId: string) => `extract-${importId}`

/** Chạy lại an toàn: `runExtraction` đi tiếp từ `extract_cursor`, section đã trích không gọi AI lại. */
const extractJob = defineJob<ExtractJobData>({
  queue: "import",
  name: "extract",
  options: { attempts: 2, backoff: { type: "exponential", delay: 30_000 } },
  // Không trả kết quả: BullMQ lưu giá trị trả về vào Redis
  process: async ({ projectId, userId, importId }) => {
    await runExtraction(projectId, userId, importId)
  },
  onFinalFailure: async ({ importId }, err) => {
    console.error(`[I-4] Job trích field của import ${importId} lỗi:`, err)
    await ImportedDocument.updateOne({ _id: importId, status: "extracting" }, { $set: { paused: { reason: "resume_later", at: new Date() } } }).catch(
      () => undefined
    )
  }
})

export const isExtractionRunning = (importId: string): Promise<boolean> => isJobActive(extractJob, jobKey(importId))

/** Kiểm điều kiện (lỗi trạng thái trả ngay cho client) rồi chạy I-4 nền. Trả bản ghi import hiện tại. */
export const startExtraction = async (projectId: string, userId: string, importId: string): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, importId)
  assertImportStatus(doc, ["extracting"], "extracting")
  // Bỏ `paused` trước khi trả lời để lần poll đầu không thấy trạng thái dừng cũ.
  const started = await startJob(
    extractJob,
    { projectId, userId, importId },
    {
      key: jobKey(importId),
      prepare: async () => {
        await ImportedDocument.updateOne({ _id: importId }, { $set: { paused: null } })
      }
    }
  )
  if (started) doc.paused = null
  return doc
}

/**
 * Import đang `extracting`, không dừng, mà không có job (đang chờ / chạy / chờ retry) ⇒ job đã mất. Đánh dấu
 * `paused: resume_later` để người dùng bấm tiếp tục.
 */
export const markOrphanedExtraction = async (doc: IImportedDocument): Promise<void> => {
  if (doc.status !== "extracting" || doc.paused) return
  if (!doc.extract_cursor) return // chưa từng chạy (vừa xác nhận mapping) — không phải job mất
  if (await isExtractionRunning(String(doc._id))) return
  doc.paused = { reason: "resume_later", at: new Date() }
  await doc.save()
}

/** Chờ job của một import chạy xong (test, script đo). */
export const waitForExtraction = (importId: string): Promise<void> => waitForJob(extractJob, jobKey(importId))
