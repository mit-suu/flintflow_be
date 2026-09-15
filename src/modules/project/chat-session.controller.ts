import { Request, Response } from "express"
import * as chatSessionService from "./chat-session.service.js"
import { getProjectById } from "./project.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

/**
 * F5 (review T13, IDOR): xác nhận user đã đăng nhập SỞ HỮU `projectId` trên đường dẫn trước khi chạm tới
 * bất kỳ chat session nào của project đó — 404 PROJECT_NOT_FOUND nếu không (cùng pattern pipeline.controller).
 */
const authorizeProject = async (req: Request): Promise<{ projectId: string; userId: string }> => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }
  const projectId = req.params.projectId as string
  if (!projectId) {
    throw new ApiError(400, "Project ID is required", "PROJECT_ID_REQUIRED")
  }
  await getProjectById(projectId, userId)
  return { projectId, userId }
}

/** F5: sau khi xác nhận project, xác nhận thêm `chatId` thuộc ĐÚNG project đó (chặn IDOR đoán chatId). */
const requireChatId = (req: Request): string => {
  const chatId = req.params.chatId as string
  if (!chatId) {
    throw new ApiError(400, "Chat Session ID is required", "CHAT_ID_REQUIRED")
  }
  return chatId
}

export const createChatSession = catchAsync(async (req: Request, res: Response) => {
  const { projectId } = await authorizeProject(req)
  const session = await chatSessionService.createChatSession(projectId)
  return sendSuccess(res, 201, session)
})

export const getChatSessions = catchAsync(async (req: Request, res: Response) => {
  const { projectId } = await authorizeProject(req)
  const sessions = await chatSessionService.getChatSessions(projectId)
  return sendSuccess(res, 200, sessions)
})

export const getChatSession = catchAsync(async (req: Request, res: Response) => {
  const { projectId } = await authorizeProject(req)
  const chatId = requireChatId(req)
  await chatSessionService.assertChatSessionOwnership(projectId, chatId)

  const session = await chatSessionService.getChatSessionById(chatId)
  return sendSuccess(res, 200, session)
})

export const sendMessage = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorizeProject(req)
  const chatId = requireChatId(req)
  await chatSessionService.assertChatSessionOwnership(projectId, chatId)

  const { content, step, discoveryStep, workspacePhase } = req.body

  if (!content) {
    throw new ApiError(400, "Message content is required", "CONTENT_REQUIRED")
  }
  if (!step) {
    throw new ApiError(400, "Step is required", "STEP_REQUIRED")
  }

  const updatedSession = await chatSessionService.sendMessageAndGetResponse(
    projectId,
    chatId,
    content,
    step,
    userId,
    discoveryStep ? Number(discoveryStep) : undefined,
    workspacePhase
  )
  return sendSuccess(res, 200, updatedSession)
})

export const sendMessageStream = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorizeProject(req)
  const chatId = requireChatId(req)
  await chatSessionService.assertChatSessionOwnership(projectId, chatId)

  const { content, step, discoveryStep } = req.body

  if (!content) {
    throw new ApiError(400, "Message content is required", "CONTENT_REQUIRED")
  }
  if (!step) {
    throw new ApiError(400, "Step is required", "STEP_REQUIRED")
  }

  // Set SSE streaming headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")
  res.flushHeaders?.()

  await chatSessionService.sendMessageStream(
    projectId,
    chatId,
    content,
    step,
    userId,
    res,
    discoveryStep ? Number(discoveryStep) : undefined
  )
})

export const deleteChatSession = catchAsync(async (req: Request, res: Response) => {
  const { projectId } = await authorizeProject(req)
  const chatId = requireChatId(req)
  await chatSessionService.assertChatSessionOwnership(projectId, chatId)

  await chatSessionService.deleteChatSession(chatId)
  return sendSuccess(res, 200, { message: "Chat session deleted successfully" })
})

export const rollbackChatSession = catchAsync(async (req: Request, res: Response) => {
  const { projectId } = await authorizeProject(req)
  const chatId = requireChatId(req)
  await chatSessionService.assertChatSessionOwnership(projectId, chatId)

  const { messageIndex } = req.body
  if (messageIndex === undefined || messageIndex === null) {
    throw new ApiError(400, "messageIndex is required", "MESSAGE_INDEX_REQUIRED")
  }

  const updatedSession = await chatSessionService.rollbackMessages(
    chatId,
    Number(messageIndex)
  )
  return sendSuccess(res, 200, updatedSession)
})
