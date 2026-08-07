import { Request, Response } from "express"
import * as specificationService from "./specification.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { SectionType } from "./section.model.js"

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
