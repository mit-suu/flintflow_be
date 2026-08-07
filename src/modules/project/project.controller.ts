import { Request, Response } from "express"
import * as projectService from "./project.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { CreateProjectDTO, RenameProjectDTO } from "./project.validation.js"
import { ProjectStatus } from "./project.model.js"

export const listProjects = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED")

  const status = (req.query.status as ProjectStatus) ?? "active"
  const projects = await projectService.listProjects(userId, status)

  return sendSuccess(res, 200, projects)
})

export const createProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED")

  const { name } = req.body as CreateProjectDTO
  const project = await projectService.createProject(userId, name)

  return sendSuccess(res, 201, project)
})

export const renameProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED")

  const id = req.params.id as string
  const { name } = req.body as RenameProjectDTO
  const project = await projectService.renameProject(userId, id, name)

  return sendSuccess(res, 200, project)
})

export const archiveProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Unauthorized", "UNAUTHORIZED")

  const id = req.params.id as string
  await projectService.archiveProject(userId, id)

  return sendSuccess(res, 200, null)
})
