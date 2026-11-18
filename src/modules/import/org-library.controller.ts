import type { Request, Response } from "express"
import mongoose from "mongoose"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { getProjectById } from "../project/project.service.js"
import { authorizeMode1, mode1Handler, parseInput } from "./mode1.http.js"
import { toImportDto } from "./import.service.js"
import * as service from "./org-library.service.js"
import { receiveDocx, requireFile } from "./import.controller.js"
import * as versions from "./org-template-versions.service.js"
import * as skeleton from "./template-skeleton.service.js"
import type { TemplateActor } from "./org-template-versions.service.js"
import {
  importFromOrgSchema,
  publishVersionSchema,
  skeletonDecisionsSchema,
  saveToOrgSchema,
  templatesQuerySchema,
  uploadTemplateSchema,
  versionParamSchema
} from "./org-library.dto.js"

/** Route dự án dùng được ở mọi chế độ (Luồng 2 là `fpt`, sau baseline là `import`) — chỉ cần dự án thuộc org đang mở. */
const projectOf = async (req: Request) => {
  const projectId = String(req.params.id)
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  const orgId = requireOrgId(req)
  await getProjectById(projectId, orgId)
  return { projectId, orgId, userId: req.user!.userId }
}
/** Route tổ chức: `orgContextFromParam` đã kiểm membership của `:orgId`. */
const orgOf = (req: Request): string => req.orgContext!.orgId
/** Vai trò trong org đang thao tác (đọc từ membership mỗi request, không từ token). */
const actorOf = (req: Request): TemplateActor => ({ userId: req.user!.userId, role: req.orgContext!.role })
const versionOf = (req: Request): number => {
  const v = versionParamSchema.safeParse(req.params.version)
  if (!v.success) throw new ApiError(404, "Không tìm thấy bản này của mẫu.", "ORG_TEMPLATE_VERSION_NOT_FOUND")
  return v.data
}

export const importFromOrg = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(importFromOrgSchema, req.body)
  const doc = await service.importFromOrg(auth.projectId, requireOrgId(req), auth.userId, body)
  return sendSuccess(res, 201, { import: toImportDto(doc) })
})
export const saveToOrg = mode1Handler(async (req, res) => {
  const p = await projectOf(req)
  const body = parseInput(saveToOrgSchema, req.body)
  return sendSuccess(res, 201, await service.saveImportToOrg(p.projectId, p.orgId, actorOf(req), body))
})

/** FLF-395 (D13): mục BA tự đặt của mẫu khung tự lưu — `null` khi dự án không có khung tự lưu. */
export const getSkeletonPending = catchAsync(async (req: Request, res: Response) => {
  const p = await projectOf(req)
  return sendSuccess(res, 200, await skeleton.getPendingHeadings(p.projectId, p.orgId))
})
export const decideSkeletonPending = mode1Handler(async (req, res) => {
  const p = await projectOf(req)
  const body = parseInput(skeletonDecisionsSchema, req.body)
  return sendSuccess(res, 200, await skeleton.decidePendingHeadings(p.projectId, p.orgId, req.orgContext!.role, body.decisions))
})
export const suggestSkeletonNames = mode1Handler(async (req, res) => {
  const p = await projectOf(req)
  return sendSuccess(res, 200, await skeleton.suggestGenericNames(p.projectId, p.orgId, p.userId, req.orgContext!.role))
})

/** Có `page` ⇒ một trang + `meta` (trang Thư viện); không có ⇒ danh sách cũ cho ô chọn mẫu lúc tạo dự án. */
export const listOrgTemplates = catchAsync(async (req: Request, res: Response) => {
  const query = parseInput(templatesQuerySchema, req.query)
  const role = req.orgContext!.role
  if (query.page === undefined) return sendSuccess(res, 200, await service.listOrgTemplates(orgOf(req), role))
  const result = await versions.listOrgTemplatesPage(orgOf(req), role, { ...query, page: query.page })
  return sendSuccess(res, 200, result.items, result.meta)
})
export const deleteOrgTemplate = catchAsync(async (req: Request, res: Response) =>
  sendSuccess(res, 200, await service.deleteOrgTemplate(orgOf(req), String(req.params.templateId)))
)

/** FLF-395: tải file mẫu (họ mới hoặc bản mới) ⇒ bản nháp + mapping tự nhận để Lead rà. */
export { receiveDocx as receiveTemplateFile }
export const uploadTemplate = mode1Handler(async (req, res) => {
  const body = parseInput(uploadTemplateSchema, req.body)
  const templateId = req.params.templateId ? String(req.params.templateId) : undefined
  return sendSuccess(res, 201, await versions.uploadTemplateDraft(orgOf(req), actorOf(req), { templateId, name: body.name, file: requireFile(req) }))
})
export const getTemplateVersion = catchAsync(async (req: Request, res: Response) =>
  sendSuccess(res, 200, await versions.getVersionDetail(orgOf(req), req.orgContext!.role, String(req.params.templateId), versionOf(req)))
)
export const publishTemplateVersion = mode1Handler(async (req, res) => {
  const body = parseInput(publishVersionSchema, req.body ?? {})
  return sendSuccess(res, 200, await versions.publishVersion(orgOf(req), actorOf(req), String(req.params.templateId), versionOf(req), body.headings))
})
export const deleteTemplateVersion = catchAsync(async (req: Request, res: Response) =>
  sendSuccess(res, 200, await versions.deleteVersion(orgOf(req), String(req.params.templateId), versionOf(req)))
)
