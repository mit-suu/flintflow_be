import { Request, Response } from "express"
import * as folderService from "./folder.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import type { ProjectIdsDTO, CreateFolderDTO, UpdateFolderDTO } from "./folder.validation.js"

const requireUserId = (req: Request): string => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }
  return userId
}

export const listFolders = catchAsync(async (req: Request, res: Response) => {
  const folders = await folderService.listFolders(requireOrgId(req))
  return sendSuccess(res, 200, folders)
})

export const createFolder = catchAsync(async (req: Request, res: Response) => {
  const folder = await folderService.createFolder(requireOrgId(req), requireUserId(req), req.body as CreateFolderDTO)
  return sendSuccess(res, 201, folder)
})

export const updateFolder = catchAsync(async (req: Request, res: Response) => {
  const folder = await folderService.updateFolder(requireOrgId(req), req.params.folderId as string, req.body as UpdateFolderDTO)
  return sendSuccess(res, 200, folder)
})

export const deleteFolder = catchAsync(async (req: Request, res: Response) => {
  const result = await folderService.deleteFolder(requireOrgId(req), req.params.folderId as string)
  return sendSuccess(res, 200, result)
})

export const addProjectsToFolder = catchAsync(async (req: Request, res: Response) => {
  const { projectIds } = req.body as ProjectIdsDTO
  const result = await folderService.addProjectsToFolder(requireOrgId(req), req.params.folderId as string, projectIds)
  return sendSuccess(res, 200, result)
})

export const removeProjectsFromFolder = catchAsync(async (req: Request, res: Response) => {
  const { projectIds } = req.body as ProjectIdsDTO
  const result = await folderService.removeProjectsFromFolder(requireOrgId(req), req.params.folderId as string, projectIds)
  return sendSuccess(res, 200, result)
})
