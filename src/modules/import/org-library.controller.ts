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
import { contentEntrySchema, importFromOrgSchema, patchContentEntrySchema, saveSectionSchema, saveToOrgSchema } from "./org-library.dto.js"

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

export const importFromOrg = mode1Handler(async (req, res) => {
  const auth = await authorizeMode1(req)
  const body = parseInput(importFromOrgSchema, req.body)
  const doc = await service.importFromOrg(auth.projectId, requireOrgId(req), auth.userId, body)
  return sendSuccess(res, 201, { import: toImportDto(doc) })
})
export const saveToOrg = mode1Handler(async (req, res) => {
  const p = await projectOf(req)
  const body = parseInput(saveToOrgSchema, req.body)
  return sendSuccess(res, 201, await service.saveImportToOrg(p.projectId, p.orgId, p.userId, body.name))
})
export const libraryMatches = catchAsync(async (req: Request, res: Response) => {
  const p = await projectOf(req)
  return sendSuccess(res, 200, await service.libraryMatches(p.projectId, p.orgId))
})
export const saveSectionToLibrary = mode1Handler(async (req, res) => {
  const p = await projectOf(req)
  const body = parseInput(saveSectionSchema, req.body)
  return sendSuccess(res, 201, await service.saveSectionToLibrary(p.projectId, p.orgId, p.userId, body.custom_section_id))
})

export const listOrgTemplates = catchAsync(async (req: Request, res: Response) => sendSuccess(res, 200, await service.listOrgTemplates(orgOf(req))))
export const deleteOrgTemplate = catchAsync(async (req: Request, res: Response) => {
  await service.deleteOrgTemplate(orgOf(req), String(req.params.templateId))
  return sendSuccess(res, 200, { deleted: true })
})
export const listContent = catchAsync(async (req: Request, res: Response) => sendSuccess(res, 200, await service.listContent(orgOf(req))))
export const upsertContent = mode1Handler(async (req, res) =>
  sendSuccess(res, 201, await service.upsertContent(orgOf(req), req.user!.userId, parseInput(contentEntrySchema, req.body)))
)
export const updateContent = mode1Handler(async (req, res) =>
  sendSuccess(res, 200, await service.updateContent(orgOf(req), req.user!.userId, String(req.params.entryId), parseInput(patchContentEntrySchema, req.body)))
)
export const deleteContent = catchAsync(async (req: Request, res: Response) => {
  await service.deleteContent(orgOf(req), String(req.params.entryId))
  return sendSuccess(res, 200, { deleted: true })
})
