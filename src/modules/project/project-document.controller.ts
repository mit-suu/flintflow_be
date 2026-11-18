import { Request, Response } from "express"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import * as projectDocumentService from "./project-document.service.js"
import { listSources } from "./requirement-source.service.js"
import { getProjectById } from "./project.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { precheckDocx } from "../import/docx-precheck.js"
import { referenceTokenMeta } from "./document-token-limit.js"

/** FLF-292: nguồn tài liệu của từng phần tử Spine (phần tử đã xoá khỏi Spine không trả về). */
export const getSources = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId
  await getProjectById(projectId, requireOrgId(req))
  const record = await spineRepository.get(projectId)
  if (!record) return sendSuccess(res, 200, { sources: [] })
  const { projectId: _projectId, ...spine } = record
  return sendSuccess(res, 200, { sources: await listSources(projectId, spine) })
})

export const uploadDocument = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId
  const file = (req as Request & { file?: Express.Multer.File }).file

  // FLF-398: lựa chọn sau `409 POSSIBLE_NEW_VERSION` — gửi kèm form (multipart): `replace_document_id` hoặc `keep_both=true`
  const body = (req.body ?? {}) as { replace_document_id?: unknown; keep_both?: unknown }
  const replaceDocumentId = typeof body.replace_document_id === "string" && body.replace_document_id.trim() ? body.replace_document_id.trim() : null
  const keepBoth = body.keep_both === true || body.keep_both === "true"
  const document = await projectDocumentService.uploadProjectDocument(requireOrgId(req), userId, projectId, file as Express.Multer.File, {
    replaceDocumentId,
    keepBoth
  })
  // Business-flow §3.6: file trông như SRS đính kèm ở chat / ô tham khảo ⇒ FE gợi ý (cập nhật phiên bản mới / dùng làm tham khảo)
  const precheck = file ? await precheckDocx(file.buffer, document.originalName ?? file.originalname, { projectId }).catch(() => null) : null
  return sendSuccess(res, 201, { ...document.toJSON(), precheck })
})

/** `POST /projects/precheck-docx` — hộp Tạo dự án: file ở ô tham khảo có trông như SRS không (không cần dự án, không lưu file). */
export const precheckDocument = catchAsync(async (req: Request, res: Response) => {
  const file = (req as Request & { file?: Express.Multer.File }).file
  if (!file) throw new ApiError(400, "Vui lòng chọn file để kiểm tra.", "FILE_REQUIRED")
  // multer đọc tên file theo latin1 — đổi lại UTF-8 để giữ tên tiếng Việt
  const originalName = Buffer.from(file.originalname, "latin1").toString("utf8")
  return sendSuccess(res, 200, await precheckDocx(file.buffer, originalName))
})

export const getDocuments = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId
  const orgId = requireOrgId(req)
  const documents = await projectDocumentService.getProjectDocuments(orgId, projectId)
  // FLF-405: FE hiện "đã dùng x / y token" của tài liệu tham khảo
  return sendSuccess(res, 200, documents, await referenceTokenMeta(orgId, projectId))
})

export const deleteDocument = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId
  const documentId = Array.isArray(req.params.documentId) ? req.params.documentId[0] : req.params.documentId
  await projectDocumentService.deleteProjectDocument(requireOrgId(req), projectId, documentId)
  return sendSuccess(res, 200, { deleted: true })
})
