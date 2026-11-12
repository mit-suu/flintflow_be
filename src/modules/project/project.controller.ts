import { Request, Response } from "express"
import * as projectService from "./project.service.js"
import { retryPendingConversion } from "../import/convert-from-fpt.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import type { CreateProjectDTO, DisableScreenMockupsDTO, MoveProjectDTO, RunScreenMockupsDTO, UpdateDocumentLanguageDTO, UpdateErdNotationDTO, UpdateScreenThemeDTO } from "./project.validation.js"
import { ScreenMockupsQuerySchema } from "./project.validation.js"
import { validationError } from "../../shared/utils/validation-message.js"
import * as screenMockupService from "../diagram/screen-mockup.service.js"
import * as screenMockupRuns from "../diagram/screen-mockup-runs.js"

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
  if (await retryPendingConversion(project, userId)) return sendSuccess(res, 200, await projectService.getProjectById(projectId, orgId))
  return sendSuccess(res, 200, project)
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

/** Đổi theme mockup màn (FLF-410) — body đã qua `UpdateScreenThemeSchema` (strict); mockup đã vẽ được vẽ lại bằng spec đã lưu. */
export const setScreenTheme = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }

  const patch = req.body as UpdateScreenThemeDTO
  const project = await projectService.setScreenTheme(req.params.projectId as string, requireOrgId(req), patch, userId)
  return sendSuccess(res, 200, project)
})

const requireUser = (req: Request): string => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  return userId
}

/**
 * FLF-410: GET /projects/:id/screen-mockups — có `mode` (+ `scope`, `screen_id`) ⇒ ước tính `{ screens, ai_calls, credits }`
 * (không gọi model); không ⇒ tóm tắt `{ with_original, using_mockup, screens }` cho cài đặt dự án.
 */
export const screenMockupsInfo = catchAsync(async (req: Request, res: Response) => {
  requireUser(req)
  const parsed = ScreenMockupsQuerySchema.safeParse(req.query)
  if (!parsed.success) throw validationError(parsed.error)
  const { mode, scope, screen_id } = parsed.data
  const projectId = req.params.projectId as string
  if (!mode) return sendSuccess(res, 200, await screenMockupService.summary(projectId, requireOrgId(req)))
  return sendSuccess(res, 200, await screenMockupService.estimate(projectId, requireOrgId(req), { mode, scope: scope ?? "all", ...(screen_id ? { screen_id } : {}) }))
})

/**
 * FLF-410: POST /projects/:id/screen-mockups — bắt đầu lượt vẽ lại ảnh gốc bằng mockup chạy nền (body đã qua
 * `RunScreenMockupsSchema`). Credit kiểm ngay (402); trả 202 + tiến độ ban đầu, FE hỏi `GET …/screen-mockups/run`.
 */
export const runScreenMockups = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUser(req)
  const body = req.body as RunScreenMockupsDTO
  return sendSuccess(res, 202, await screenMockupRuns.startRun(req.params.projectId as string, requireOrgId(req), userId, body))
})

/** FLF-410: GET /projects/:id/screen-mockups/:screenId/original — ảnh gốc của màn (PNG/JPEG) làm hình minh hoạ. */
export const screenOriginalImage = catchAsync(async (req: Request, res: Response) => {
  requireUser(req)
  const image = await screenMockupService.originalImageOf(req.params.projectId as string, requireOrgId(req), req.params.screenId as string)
  res.setHeader("Content-Type", image.mime)
  res.setHeader("Cache-Control", "private, max-age=300")
  return res.status(200).send(image.data)
})

/** FLF-410: GET /projects/:id/screen-mockups/run — tiến độ lượt gần nhất (`null` = chưa từng chạy). */
export const screenMockupRun = catchAsync(async (req: Request, res: Response) => {
  requireUser(req)
  return sendSuccess(res, 200, await screenMockupRuns.getRun(req.params.projectId as string, requireOrgId(req)))
})

/** FLF-410: POST /projects/:id/screen-mockups/run/cancel — dừng sau màn đang vẽ. */
export const cancelScreenMockupRun = catchAsync(async (req: Request, res: Response) => {
  requireUser(req)
  return sendSuccess(res, 200, await screenMockupRuns.cancelRun(req.params.projectId as string, requireOrgId(req)))
})

/** FLF-410: DELETE /projects/:id/screen-mockups — dùng lại ảnh gốc (giữ hình đã vẽ), không tốn credit. */
export const disableScreenMockups = catchAsync(async (req: Request, res: Response) => {
  requireUser(req)
  const body = req.body as DisableScreenMockupsDTO
  return sendSuccess(res, 200, await screenMockupService.disable(req.params.projectId as string, requireOrgId(req), body))
})
