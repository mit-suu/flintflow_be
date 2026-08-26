import { Request, Response } from "express"
import * as projectService from "./project.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const createProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const { name, domain } = req.body
  if (!name) {
    throw new ApiError(400, "Project name is required", "NAME_REQUIRED")
  }

  const project = await projectService.createProject(userId, name, domain)
  return sendSuccess(res, 201, project)
})

export const getProjects = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const status = req.query.status as string | undefined
  const projects = await projectService.getProjects(userId, status)
  return sendSuccess(res, 200, projects)
})

export const getProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const project = await projectService.getProjectById(projectId, userId)
  return sendSuccess(res, 200, project)
})

export const deleteProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const hard = req.query.hard === "true"
  const statusParam = req.query.status
  const status = statusParam === "archived" ? "archived" : "inactive"
  const result = await projectService.deleteProject(projectId, userId, hard, status)
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

  const project = await projectService.updateProjectName(projectId, userId, name)
  return sendSuccess(res, 200, project)
})
