/**
 * Controller import mode 1 — contract `docs/api/import-change-contract.md` §1 endpoint 2–11. FLF-171.
 * Controller chỉ: kiểm quyền + mode → parse DTO → gọi service → envelope. Nghiệp vụ ở `*.service.ts`.
 */

import type { NextFunction, Request, Response } from "express"
import multer from "multer"
import { sendSuccess } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILE_MB, fileTooLargeMessage } from "./import.constants.js"
import {
  IMPORT_FILE_FIELD,
  confirmLatestRequestSchema,
  extractRequestSchema,
  documentLanguageRequestSchema,
  dropTextRequestSchema,
  fieldsPatchRequestSchema,
  finalizeRequestSchema,
  continueFlow2RequestSchema,
  gapReportQuerySchema,
  importResumeRequestSchema,
  reviewSectionRequestSchema,
  mappingPatchRequestSchema,
  stepPlanPatchRequestSchema,
  uploadImportBodySchema
} from "./import.dto.js"
import * as extractService from "./extract.service.js"
import * as extractJobs from "./extract-jobs.js"
import * as finalizeJobs from "./finalize-jobs.js"
import { continueInFlow2 } from "./flow2.service.js"
import * as layoutPreviewService from "./layout-preview.service.js"
import * as gapReportService from "./gap-report.service.js"
import { Mode1Error } from "./mode1.errors.js"
import { assertNotMode1 } from "./mode1-guard.js"
import * as importService from "./import.service.js"
import { assertImportStatus } from "./import.service.js"
import { IMPORT_STATUS_LABELS } from "./import.state.js"
import { TemplateProfile } from "./template-profile.model.js"
import * as reviewService from "./review.service.js"
import { buildImportSource, importSourceEtag } from "./import-source.service.js"
import * as reuploadService from "./reupload.service.js"
import * as stepPlanService from "./step-plan.service.js"
import { authorizeMode1, mode1Handler, parseInput } from "./mode1.http.js"
import { getAuthClient } from "../google/google-auth.service.js"
import { fetchDocxFromDrive } from "../google/google-import.service.js"
import { ImportGoogleDocSchema } from "../google/google.validation.js"
import { IMPORTED_DOC_VERSION } from "../doc-version/versioning.js"

/**
 * Multer giữ file trong bộ nhớ. Giới hạn cứng gấp đôi giới hạn nghiệp vụ: file hơi quá cỡ vẫn tới preflight để
 * trả `FILE_TOO_LARGE` có bản ghi; file quá lớn hẳn bị chặn ở đây (413 `FILE_TOO_LARGE`, câu nêu giới hạn
 * `IMPORT_MAX_FILE_MB` — không phải giới hạn gấp đôi này, `meta.max_mb` cho FE dịch).
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_FILE_BYTES * 2, files: 1 } })

export const receiveDocx = (req: Request, res: Response, next: NextFunction): void => {
  upload.single(IMPORT_FILE_FIELD)(req, res, (err: unknown) => {
    // Quá cỡ ⇒ câu riêng của import (giới hạn MB + cách nén ảnh); lỗi multer khác ⇒ error handler chung (UPLOAD_FAILED) — FLF-247
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(new ApiError(413, fileTooLargeMessage(), "FILE_TOO_LARGE", { max_mb: IMPORT_MAX_FILE_MB }))
    }
    if (err) return next(err)
    next()
  })
}

export const requireFile = (req: Request): importService.UploadedFile => {
  const file = req.file
  if (!file) throw new ApiError(400, "Vui lòng chọn file .docx để tải lên.", "VALIDATION_ERROR", { field: IMPORT_FILE_FIELD })
  // multer đọc tên file theo latin1 — đổi lại UTF-8 để giữ tên tiếng Việt
  const originalname = Buffer.from(file.originalname, "latin1").toString("utf8")
  return { buffer: file.buffer, originalname, size: file.size }
}

export const uploadImport = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  // Client cũ gửi kèm `intent`: vẫn kiểm định dạng nhưng bỏ qua — ý định lấy từ Project (hộp Tạo dự án)
  parseInput(uploadImportBodySchema, req.body)
  const doc = await importService.uploadImport(auth.projectId, auth.userId, requireFile(req))
  return sendSuccess(res, 201, { import: importService.toImportDto(doc) })
})

/**
 * `POST /projects/:id/import/google-docs` `{ fileId }` (contract #46) — như `POST /:id/import` nhưng file lấy từ Google
 * Drive (Google Doc xuất sang .docx, hoặc .docx có sẵn). Từ `uploadImport` trở đi là đúng luồng upload cũ.
 */
export const importFromGoogleDocs = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { fileId } = parseInput(ImportGoogleDocSchema, req.body)
  const file = await fetchDocxFromDrive(await getAuthClient(auth.userId), fileId)
  const doc = await importService.uploadImport(auth.projectId, auth.userId, file)
  return sendSuccess(res, 201, { import: importService.toImportDto(doc) })
})

export const confirmLatest = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(confirmLatestRequestSchema, req.body)
  const doc = await importService.confirmLatest(auth.projectId, body.import_id)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

export const getImport = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req, { allowDrafting: true })
  const current = await importService.latestImport(auth.projectId)
  if (current) {
    await extractJobs.markOrphanedExtraction(current)
    await finalizeJobs.markOrphanedFinalize(current)
  }
  const view = await importService.getImportView(auth.projectId)
  // Ước tính credit một lần trước khi chạy (màn Bắt đầu / chạy tiếp, FLF-343) — job đang chạy thì FE đang xem tiến độ, không tính
  if (current && !(await extractJobs.isExtractionRunning(String(current._id)))) {
    const role = req.orgContext?.role
    view.credit_estimate = await extractService.creditEstimateFor(auth.projectId, auth.userId, current, { withBalance: role === "lead" || role === "analyst" })
  }
  return sendSuccess(res, 200, view)
})

/**
 * Chữ gốc của file theo mục cho màn đọc file: tải một lần. `ETag` theo bản import + số block; FE gửi lại `If-None-Match` ⇒ 304
 * không đọc nội dung.
 */
export const getImportSource = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const { importId, etag } = await importSourceEtag(auth.projectId)
  res.setHeader("ETag", etag)
  res.setHeader("Cache-Control", "private, no-cache")
  if (req.headers["if-none-match"]?.split(",").some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) return res.status(304).end()
  return sendSuccess(res, 200, await buildImportSource(auth.projectId, importId))
})

export const patchMapping = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(mappingPatchRequestSchema, req.body)
  const doc = await importService.patchMapping(auth.projectId, body)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

export const reupload = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req, { allowBeforeBaseline: true })
  const diff = await reuploadService.reupload(auth.projectId, auth.userId, requireFile(req), auth.project)
  return sendSuccess(res, 201, reuploadService.toReuploadDto(diff))
})

export const extract = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(extractRequestSchema, req.body)
  return sendSuccess(res, 200, await startExtractionResponse(auth.projectId, auth.userId, body.import_id, body.confirm_latest))
})

/**
 * Nút "Bắt đầu" (FLF-343): I-4 ⇒ baseline 0.1 ⇒ kiểm tra chạy nền một mạch; trả ngay trạng thái hiện tại (`extracting`), FE
 * poll `GET /import` tới `gap_review` (xem `extract-jobs.ts`).
 */
const startExtractionResponse = async (projectId: string, userId: string, importId: string, confirmLatest?: boolean) => {
  const doc = await extractJobs.startExtraction(projectId, userId, importId, confirmLatest)
  const summary = await importService.extractionSummary(String(doc._id))
  return { import: importService.toImportDto(doc), sections: summary.sections }
}

/** FLF-412: lưu lựa chọn Bỏ chữ theo vùng (trước Bắt đầu) + tính lại bản sơ bộ; FE đọc lại `GET /import` để có bản sơ bộ + credit mới. */
export const dropText = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(dropTextRequestSchema, req.body)
  const doc = await importService.setDropText(auth.projectId, body)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

/** FLF-456: lưu ngôn ngữ tài liệu khi file chỉ còn khung (trước Bắt đầu); FE đọc lại `GET /import` để có credit mới. */
export const documentLanguage = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(documentLanguageRequestSchema, req.body)
  const doc = await importService.setSkeletonLanguage(auth.projectId, body)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

export const patchFields = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(fieldsPatchRequestSchema, req.body)
  const doc = await extractService.patchFields(auth.projectId, body)
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

/**
 * 1.10–1.12 chạy nền (`finalize-jobs.ts`): kiểm điều kiện rồi trả ngay import `baselining` (đang chạy thì trạng thái hiện
 * tại). `baseline`/`flags` = `null` — kết quả đọc ở `GET /import` (`gap_review`) + gap report khi job xong.
 */
export const finalize = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(finalizeRequestSchema, req.body)
  const doc = await finalizeJobs.startFinalize(auth.projectId, auth.userId, body)
  const spineVersion = doc.finalize_checkpoint?.spine_version ?? body.base_version
  return sendSuccess(res, 200, { import: importService.toImportDto(doc), doc_version: IMPORTED_DOC_VERSION, baseline: null, spine_version: spineVersion, flags: null })
})

/** FLF-278 trên FLF-336: chế độ 3 ở `incomplete` ⇒ Luồng 2 (dự án sang pipeline tạo mới, viết phần còn thiếu). */
export const continueFlow2 = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(continueFlow2RequestSchema, req.body)
  return sendSuccess(res, 200, await continueInFlow2(auth.projectId, auth.userId, body))
})

/** FLF-461 (bước 2.9a): xem trước bố cục mới của chế độ 4 trước khi áp vào bản in. */
export const layoutPreview = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req, { allowDrafting: true })
  return sendSuccess(res, 200, await layoutPreviewService.getLayoutPreview(auth.projectId))
})

/** FLF-461 (bước 2.9a): người dùng xác nhận bố cục mới ⇒ bản in từ giờ áp bố cục đó. */
export const layoutConfirm = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req, { allowDrafting: true })
  return sendSuccess(res, 200, await layoutPreviewService.confirmLayout(auth.projectId))
})

/**
 * FLF-453 (business-flow §3.1.2 "Rà soát phần có sẵn"): người dùng xác nhận credit ở `reviewing` ⇒ chạy AI rà các mục
 * Code đã chọn (`TemplateProfile.review_sections`), rồi sang Luồng 2 như `continueFlow2`. Lượt AI lỗi / hết credit ⇒
 * trả `import` đang `paused`, không sang Luồng 2 — gọi lại endpoint này để tiếp tục (lượt đã trừ credit không chạy lại).
 */
export const reviewRun = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(importResumeRequestSchema, req.body)
  const doc = await importService.requireImport(auth.projectId, body.import_id)
  assertImportStatus(doc, ["reviewing"], "drafting")
  const profile = await TemplateProfile.findOne({ projectId: auth.projectId })
  const result = await reviewService.runReview(doc, auth.userId, profile?.review_sections ?? [])
  if ("paused" in result) return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
  return sendSuccess(res, 200, result)
})

/**
 * FLF-453 nút "Rà soát bằng AI" của một mục chỉ được Code kiểm (business-flow §3.1.2), ở `reviewing`. Không có `confirm: true`
 * ⇒ chỉ báo credit riêng của mục (không gọi AI, không trừ). Có `confirm` ⇒ chạy qua `runReview` cùng đường lô; vẫn `reviewing`
 * (không sang Luồng 2). Hết credit / lỗi ⇒ `{ import }` đang `paused`.
 */
export const reviewSection = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(reviewSectionRequestSchema, req.body)
  const doc = await importService.requireImport(auth.projectId, body.import_id)
  assertImportStatus(doc, ["reviewing"], "reviewing")
  const profile = await TemplateProfile.findOne({ projectId: auth.projectId })
  const options = await reviewService.optionalReviewSections(auth.projectId, profile?.target_structure, profile?.review_sections ?? [])
  const option = options.find((o) => o.section_id === body.section_id)
  if (!option) throw new Mode1Error("IMPORT_INVALID_STATE", "Mục này không có chữ để AI rà riêng hoặc đã được rà.", { section_id: body.section_id })
  if (!body.confirm) return sendSuccess(res, 200, { section_id: option.section_id, calls: option.calls, credits: option.credits, reviewed: false })
  const result = await reviewService.runSectionReview(doc, auth.userId, option.section_id)
  if ("paused" in result) return sendSuccess(res, 200, { import: importService.toImportDto(doc), section_id: option.section_id, reviewed: false })
  return sendSuccess(res, 200, { import: importService.toImportDto(doc), section_id: option.section_id, reviewed: true })
})

/** Bấm Dừng khi vòng rà soát đang chạy (business-flow §2 "Dừng giữa chừng") — giữ tiến độ, lượt chưa trừ credit không chạy. */
export const reviewStop = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(importResumeRequestSchema, req.body)
  const doc = await importService.requireImport(auth.projectId, body.import_id)
  if (doc.status !== "reviewing") {
    throw new Mode1Error("IMPORT_INVALID_STATE", `Không thực hiện được khi lần nhập tài liệu đang ở bước "${IMPORT_STATUS_LABELS[doc.status] ?? doc.status}"`, { status: doc.status, to: "reviewing", allowed: ["reviewing"] })
  }
  doc.paused = { reason: "user", at: new Date() }
  await doc.save()
  return sendSuccess(res, 200, { import: importService.toImportDto(doc) })
})

/**
 * Tiếp tục bước đang dừng: `extracting` ⇒ I-4 từ cursor; `fields_review` (FLF-462, bước 1.6) ⇒ báo lỗi nếu còn gì cần
 * xác nhận (xem `PATCH /import/fields`), hết việc cần xác nhận mới sang `baselining`; `baselining` (job finalize lỗi /
 * mất) ⇒ chạy lại finalize từ mốc; `checking` ⇒ 1.11–1.12. Đều chạy nền, trả ngay.
 */
export const resume = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(importResumeRequestSchema, req.body)
  const doc = await importService.requireImport(auth.projectId, body.import_id)
  if (doc.status === "extracting") {
    return sendSuccess(res, 200, await startExtractionResponse(auth.projectId, auth.userId, body.import_id))
  }
  if (doc.status === "baselining" || doc.status === "checking" || doc.status === "fields_review") {
    const current = await finalizeJobs.startResume(auth.projectId, auth.userId, body.import_id)
    const summary = await importService.extractionSummary(String(current._id))
    return sendSuccess(res, 200, { import: importService.toImportDto(current), sections: summary.sections })
  }
  throw new Mode1Error("IMPORT_INVALID_STATE", "Không có bước nào đang dừng để tiếp tục", {
    status: doc.status,
    to: doc.status,
    allowed: ["extracting", "fields_review", "baselining", "checking"]
  })
})

/** Người dùng bấm Dừng lúc đang đọc nội dung (I-4): đặt `paused: user`, job dừng trước lượt AI kế tiếp. Tiếp tục qua `resume`. */
export const pause = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(importResumeRequestSchema, req.body)
  const current = await extractJobs.requestStop(auth.projectId, body.import_id)
  const summary = await importService.extractionSummary(String(current._id))
  return sendSuccess(res, 200, { import: importService.toImportDto(current), sections: summary.sections })
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
