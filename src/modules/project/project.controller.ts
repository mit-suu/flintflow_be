import { Request, Response } from "express"
import * as projectService from "./project.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import type { CreateProjectDTO, MoveProjectDTO } from "./project.validation.js"

export const createProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  // Body đã qua CreateProjectSchema ở route: name không rỗng, mode thuộc PROJECT_MODES (thiếu ⇒ fpt)
  const { name, mode, domain, folderId } = req.body as CreateProjectDTO
  const project = await projectService.createProject(requireOrgId(req), userId, name, domain, mode, folderId)
  return sendSuccess(res, 201, project)
})

export const getProjects = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const status = req.query.status as string | undefined
  const projects = await projectService.getProjects(requireOrgId(req), status)
  return sendSuccess(res, 200, projects)
})

export const getProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const project = await projectService.openProject(projectId, requireOrgId(req))
  return sendSuccess(res, 200, project)
})

export const deleteProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const hard = req.query.hard === "true"
  const result = await projectService.deleteProject(projectId, requireOrgId(req), hard)
  return sendSuccess(res, 200, result)
})

export const updateProjectName = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const { name } = req.body
  if (!name) {
    throw new ApiError(400, "Project name is required", "NAME_REQUIRED")
  }

  const project = await projectService.updateProjectName(projectId, requireOrgId(req), name)
  return sendSuccess(res, 200, project)
})

export const moveProjectToFolder = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const { folderId } = req.body as MoveProjectDTO
  const project = await projectService.moveProjectToFolder(req.params.projectId as string, requireOrgId(req), folderId)
  return sendSuccess(res, 200, project)
})
