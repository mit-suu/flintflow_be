import { Request, Response } from "express"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import * as projectDocumentService from "./project-document.service.js"
import { listSources } from "./requirement-source.service.js"
import { getProjectById } from "./project.service.js"
import * as spineRepository from "../spine/spine.repository.js"

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

  const document = await projectDocumentService.uploadProjectDocument(requireOrgId(req), userId, projectId, file as Express.Multer.File)
  return sendSuccess(res, 201, document)
})

export const getDocuments = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId
  const documents = await projectDocumentService.getProjectDocuments(requireOrgId(req), projectId)
  return sendSuccess(res, 200, documents)
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
