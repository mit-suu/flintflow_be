/**
 * Controller import mode 1 — contract `docs/api/import-change-contract.md` §1 endpoint 2–11. FLF-171.
 * Controller chỉ: kiểm quyền + mode → parse DTO → gọi service → envelope. Nghiệp vụ ở `*.service.ts`.
 */

import type { NextFunction, Request, Response } from "express"
import multer from "multer"
import { sendSuccess } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { IMPORT_MAX_FILE_BYTES } from "./import.constants.js"
import {
  IMPORT_FILE_FIELD,
  confirmLatestRequestSchema,
  extractRequestSchema,
  fieldsPatchRequestSchema,
  finalizeRequestSchema,
  gapReportQuerySchema,
  importResumeRequestSchema,
  mappingPatchRequestSchema,
  stepPlanPatchRequestSchema
} from "./import.dto.js"
import * as extractService from "./extract.service.js"
import * as extractJobs from "./extract-jobs.js"
import * as finalizeService from "./finalize.service.js"
import * as gapReportService from "./gap-report.service.js"
import { Mode1Error } from "./mode1.errors.js"
import { assertNotMode1 } from "./mode1-guard.js"
import * as importService from "./import.service.js"
import * as reuploadService from "./reupload.service.js"
import * as stepPlanService from "./step-plan.service.js"
import { authorizeMode1, mode1Handler, parseInput } from "./mode1.http.js"

/**
 * Multer giữ file trong bộ nhớ. Giới hạn cứng gấp đôi giới hạn nghiệp vụ: file hơi quá cỡ vẫn tới preflight để
 * trả `FILE_TOO_LARGE` có bản ghi; file quá lớn hẳn bị chặn ở đây (400).
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_FILE_BYTES * 2, files: 1 } })

export const receiveDocx = (req: Request, res: Response, next: NextFunction): void => {
  upload.single(IMPORT_FILE_FIELD)(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) return next(new ApiError(400, `Upload lỗi: ${err.message}`, "VALIDATION_ERROR"))
    if (err) return next(err)
    next()
  })
}

export const requireFile = (req: Request): importService.UploadedFile => {
  const file = req.file
  if (!file) throw new ApiError(400, `Thiếu file .docx (field "${IMPORT_FILE_FIELD}")`, "VALIDATION_ERROR")
  // multer đọc tên file theo latin1 — đổi lại UTF-8 để giữ tên tiếng Việt
  const originalname = Buffer.from(file.originalname, "latin1").toString("utf8")
  return { buffer: file.buffer, originalname, size: file.size }
}

export const uploadImport = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const doc = await importService.uploadImport(auth.projectId, auth.userId, requireFile(req))
  return sendSuccess(res, 201, { import: importService.toImportDto(doc) })
})

export const confirmLatest = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(confirmLatestRequestSchema, req.body)
  const doc = await importService.confirmLatest(auth.projectId, body.import_id)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

export const getImport = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const current = await importService.latestImport(auth.projectId)
  if (current) await extractJobs.markOrphanedExtraction(current)
  return sendSuccess(res, 200, await importService.getImportView(auth.projectId))
})

export const patchMapping = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(mappingPatchRequestSchema, req.body)
  const doc = await importService.patchMapping(auth.projectId, body)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

export const reupload = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const diff = await reuploadService.reupload(auth.projectId, auth.userId, requireFile(req))
  return sendSuccess(res, 201, reuploadService.toReuploadDto(diff))
})

export const extract = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(extractRequestSchema, req.body)
  return sendSuccess(res, 200, await startExtractionResponse(auth.projectId, auth.userId, body.import_id))
})

/** I-4 chạy nền: trả ngay trạng thái hiện tại (`extracting`), FE poll `GET /import` (xem `extract-jobs.ts`). */
const startExtractionResponse = async (projectId: string, userId: string, importId: string) => {
  const doc = await extractJobs.startExtraction(projectId, userId, importId)
  const summary = await importService.extractionSummary(String(doc._id))
  return { import: importService.toImportDto(doc), sections: summary.sections }
}

export const patchFields = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(fieldsPatchRequestSchema, req.body)
  const doc = await extractService.patchFields(auth.projectId, body)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

export const finalize = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(finalizeRequestSchema, req.body)
  const result = await finalizeService.finalizeImport(auth.projectId, auth.userId, body)
  return sendSuccess(res, 200, {
    import: importService.toImportDto(result.doc),
    doc_version: "0.0",
    baseline: result.baseline,
    spine_version: result.spine_version,
    flags: result.flags
  })
})

/** Tiếp tục bước AI đang dừng: `extracting` ⇒ I-4 từ cursor; `checking` ⇒ 1.11–1.12. */
export const resume = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(importResumeRequestSchema, req.body)
  const doc = await importService.requireImport(auth.projectId, body.import_id)
  if (doc.status === "extracting") {
    return sendSuccess(res, 200, await startExtractionResponse(auth.projectId, auth.userId, body.import_id))
  }
  if (doc.status === "checking") {
    await finalizeService.resumeCheck(doc, auth.userId)
    const summary = await importService.extractionSummary(String(doc._id))
    return sendSuccess(res, 200, { import: importService.toImportDto(doc), sections: summary.sections })
  }
  throw new Mode1Error("IMPORT_INVALID_STATE", "Không có bước nào đang dừng để tiếp tục", {
    status: doc.status,
    to: doc.status,
    allowed: ["extracting", "checking"]
  })
})

export const gapReport = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const query = parseInput(gapReportQuerySchema, req.query)
  const report = await gapReportService.buildGapReport(auth.projectId)
  if (query.format === "json") return sendSuccess(res, 200, report)
  const buffer = await gapReportService.renderGapReportDocx(report, auth.project.name)
  await gapReportService.markDelivered(auth.projectId)
  const filename = `GapReport_${auth.project.name.replace(/[^p{L}p{N}_-]+/gu, "_")}_v${report.doc_version}.docx`
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8${encodeURIComponent(filename)}`)
  return res.status(200).send(buffer)
})

// ─── kế hoạch step theo template (#32–#33, FLF-183) ───────────────────

export const getStepPlan = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  return sendSuccess(res, 200, await stepPlanService.getStepPlan(auth.projectId))
})

export const patchStepPlan = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  assertNotMode1(auth.project.mode, "steps") // mode 1 v3: không bật/tắt step (BPMN Flow 1 không có step)
  const body = parseInput(stepPlanPatchRequestSchema, req.body)
  return sendSuccess(res, 200, await stepPlanService.patchStepPlan(auth.projectId, auth.userId, body))
})
