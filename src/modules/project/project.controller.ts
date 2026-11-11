import { Request, Response } from "express"
import * as projectService from "./project.service.js"
import { retryPendingConversion } from "../import/convert-from-fpt.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { templateCurrentOf, templateUpdateOf } from "../import/template-update.js"
import type { CreateProjectDTO, MoveProjectDTO, UpdateDocumentLanguageDTO, UpdateErdNotationDTO } from "./project.validation.js"

export const createProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  // Body đã qua CreateProjectSchema ở route: name không rỗng, mode thuộc PROJECT_MODES (thiếu ⇒ fpt)
  const { name, mode, domain, folderId, documentLanguage, source, has_required_template, has_srs_file, complete_to_standard } = req.body as CreateProjectDTO
  const project = await projectService.createProject(requireOrgId(req), userId, name, domain, mode, folderId, documentLanguage, { source, has_required_template, has_srs_file, complete_to_standard })
  return sendSuccess(res, 201, project)
})

export const getProjects = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const status = req.query.status as string | undefined
  const projects = await projectService.getProjects(requireOrgId(req), status)
  return sendSuccess(res, 200, projects)
})

export const getProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const orgId = requireOrgId(req)
  const project = await projectService.openProject(projectId, orgId)
  // FLF-318: dự án tạo SRS đã ký baseline mà chưa chuyển sang mode 1 (lượt ký lỗi giữa chừng / ký trước khi deploy)
  const current = (await retryPendingConversion(project, userId)) ? await projectService.getProjectById(projectId, orgId) : project
  // FLF-395: bản mẫu tổ chức mới hơn bản dự án đang theo (chỉ Lead / Analyst)
  const [templateUpdate, templateCurrent] = await Promise.all([templateUpdateOf(current, req.orgContext?.role), templateCurrentOf(current)])
  return sendSuccess(res, 200, { ...current.toJSON(), template_update: templateUpdate, template_current: templateCurrent })
})

export const deleteProject = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const hard = req.query.hard === "true"
  const result = await projectService.deleteProject(projectId, requireOrgId(req), hard)
  return sendSuccess(res, 200, result)
})

export const updateProjectName = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const { name } = req.body
  if (!name) {
    throw new ApiError(400, "Vui lòng nhập tên dự án.", "NAME_REQUIRED")
  }

  const project = await projectService.updateProjectName(projectId, requireOrgId(req), name)
  return sendSuccess(res, 200, project)
})

export const moveProjectToFolder = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const { folderId } = req.body as MoveProjectDTO
  const project = await projectService.moveProjectToFolder(req.params.projectId as string, requireOrgId(req), folderId)
  return sendSuccess(res, 200, project)
})

/** FLF-265: đổi ngôn ngữ tài liệu — body đã qua `UpdateDocumentLanguageSchema` (strict) ở route. */
export const setDocumentLanguage = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const { documentLanguage } = req.body as UpdateDocumentLanguageDTO
  const project = await projectService.setDocumentLanguage(req.params.projectId as string, requireOrgId(req), documentLanguage)
  return sendSuccess(res, 200, project)
})

/** Đổi ký pháp ERD — body đã qua `UpdateErdNotationSchema` (strict) ở route; ERD đã vẽ được vẽ lại ngay bằng ký pháp mới. */
export const setErdNotation = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const { erdNotation } = req.body as UpdateErdNotationDTO
  const project = await projectService.setErdNotation(req.params.projectId as string, requireOrgId(req), erdNotation, userId)
  return sendSuccess(res, 200, project)
})
