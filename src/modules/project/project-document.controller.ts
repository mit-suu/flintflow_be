import { Request, Response } from "express"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { ApiError } from "../../shared/utils/api-error.js"
import * as projectDocumentService from "./project-document.service.js"

export const uploadDocument = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId
  const file = (req as Request & { file?: Express.Multer.File }).file

  const document = await projectDocumentService.uploadProjectDocument(userId, projectId, file as Express.Multer.File)
  return sendSuccess(res, 201, document)
})

export const getDocuments = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId
  const documents = await projectDocumentService.getProjectDocuments(userId, projectId)
  return sendSuccess(res, 200, documents)
})

export const deleteDocument = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId
  const documentId = Array.isArray(req.params.documentId) ? req.params.documentId[0] : req.params.documentId
  await projectDocumentService.deleteProjectDocument(userId, projectId, documentId)
  return sendSuccess(res, 200, { deleted: true })
})
