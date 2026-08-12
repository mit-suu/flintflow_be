import { Request, Response } from "express"
import * as specificationService from "./specification.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { projectIdParamSchema } from "./specification.validation.js"
import { SectionType } from "./section.model.js"

// ─── Basic CRUD handlers (feat/flf-74-input-modules) ────────────────────────

export const getSections = catchAsync(async (req: Request, res: Response) => {
  const projectId = req.params.projectId as string
  if (!projectId) {
    throw new ApiError(400, "Project ID is required", "PROJECT_ID_REQUIRED")
  }

  const sections = await specificationService.getSections(projectId)
  return sendSuccess(res, 200, sections)
})

export const generateSection = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const { type, chatSessionId } = req.body

  if (!type) {
    throw new ApiError(400, "Section type is required", "TYPE_REQUIRED")
  }
  if (!chatSessionId) {
    throw new ApiError(400, "Chat session ID is required", "CHAT_SESSION_ID_REQUIRED")
  }

  const section = await specificationService.generateSection(
    projectId,
    type as SectionType,
    chatSessionId,
    userId
  )
  return sendSuccess(res, 200, section)
})

export const updateSection = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const projectId = req.params.projectId as string
  const type = req.params.type as string
  const { content, status } = req.body

  if (!content) {
    throw new ApiError(400, "Content is required", "CONTENT_REQUIRED")
  }

  const section = await specificationService.saveSection(
    projectId,
    type as SectionType,
    content,
    "user",
    "user_edited",
    status || "edited_manually"
  )
  return sendSuccess(res, 200, section)
})

// ─── UC34: Priority Ranking (main) ──────────────────────────────────────────

/**
 * UC34 - Xếp hạng tính năng theo mức ưu tiên (MoSCoW)
 * POST /api/v1/specifications/:projectId/generate-priority
 */
export const generatePriorityRanking = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const { projectId } = projectIdParamSchema.parse(req.params)

  const result = await specificationService.generatePriorityRanking(projectId, userId)

  return sendSuccess(res, 200, result)
})

// ─── UC35: Scope & Out-of-Scope (main) ──────────────────────────────────────

/**
 * UC35 - Sinh scope và out-of-scope
 * POST /api/v1/specifications/:projectId/generate-scope
 */
export const generateScopeOutOfScope = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const { projectId } = projectIdParamSchema.parse(req.params)

  const result = await specificationService.generateScopeOutOfScope(projectId, userId)

  return sendSuccess(res, 200, result)
})
