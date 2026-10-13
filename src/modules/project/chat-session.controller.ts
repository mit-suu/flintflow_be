import { Request, Response } from "express"
import * as chatSessionService from "./chat-session.service.js"
import { getProjectById } from "./project.service.js"
import { requireOrgId } from "../../shared/auth/org-request.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { isChangeInstruction } from "../spine/change.service.js"
import { changeRequiresCr, changesRequireCr, prefillFrom } from "../import/mode1-guard.js"
import { env } from "../../config/env.js"
import { KNOWLEDGE_DISABLED } from "../knowledge/answer.service.js"
import { parseKnowledgeFlag } from "./project.validation.js"

/**
 * F5 (review T13, IDOR): xác nhận user đã đăng nhập SỞ HỮU `projectId` trên đường dẫn trước khi chạm tới
 * bất kỳ chat session nào của project đó — 404 PROJECT_NOT_FOUND nếu không (cùng pattern pipeline.controller).
 */
const authorizeProject = async (req: Request): Promise<{ projectId: string; userId: string }> => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
  }
  const projectId = req.params.projectId as string
  if (!projectId) {
    throw new ApiError(400, "Thiếu thông tin dự án.", "PROJECT_ID_REQUIRED")
  }
  await getProjectById(projectId, requireOrgId(req))
  return { projectId, userId }
}

/** F5: sau khi xác nhận project, xác nhận thêm `chatId` thuộc ĐÚNG project đó (chặn IDOR đoán chatId). */
const requireChatId = (req: Request): string => {
  const chatId = req.params.chatId as string
  if (!chatId) {
    throw new ApiError(400, "Thiếu thông tin phiên trò chuyện.", "CHAT_ID_REQUIRED")
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

/**
 * FLF-267: cờ `knowledge` của tin nhắn. Bật mà máy chủ tắt Knowledge RAG ⇒ 409 `KNOWLEDGE_DISABLED` TRƯỚC khi ghi gì
 * vào phiên — lùi về CHAT thường sẽ trừ credit và trả lời không căn cứ trong khi user tưởng là câu trả lời có trích dẫn.
 */
const knowledgeFlagOf = (body: unknown): boolean => {
  const knowledge = parseKnowledgeFlag(body)
  if (knowledge && !env.KNOWLEDGE_ENABLED) {
    throw new ApiError(409, "Tính năng hỏi đáp tri thức chưa được bật trên máy chủ này.", KNOWLEDGE_DISABLED)
  }
  return knowledge
}

/** Lệnh sửa trong chat là "yêu cầu miệng có tên" (BPMN 3.1) — không có nguồn `chat` riêng. */
const chatChangeRequiresCr = (chatId: string, content: string) =>
  changeRequiresCr(prefillFrom(content, "Sửa tài liệu", { kind: "verbal", ref: `chat:${chatId}` }))

export const sendMessage = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorizeProject(req)
  const chatId = requireChatId(req)
  await chatSessionService.assertChatSessionOwnership(projectId, chatId)

  const { content, step, discoveryStep } = req.body

  if (!content) {
    throw new ApiError(400, "Vui lòng nhập nội dung tin nhắn.", "CONTENT_REQUIRED")
  }
  if (!step) {
    throw new ApiError(400, "Thiếu thông tin bước đang làm.", "STEP_REQUIRED")
  }
  const knowledge = knowledgeFlagOf(req.body)

  // Mode 1 đã import (v3, BPMN 3.1): lệnh sửa trong chat ⇒ 409 CHANGE_REQUIRES_CR kèm form điền sẵn (yêu cầu miệng).
  // Câu hỏi tri thức (FLF-267) không sửa tài liệu ⇒ không qua chốt này.
  if (!knowledge && isChangeInstruction(content) && (await changesRequireCr(projectId))) throw chatChangeRequiresCr(chatId, content)

  const updatedSession = await chatSessionService.sendMessageAndGetResponse(
    projectId,
    chatId,
    content,
    step,
    userId,
    discoveryStep ? Number(discoveryStep) : undefined,
    { knowledge }
  )
  return sendSuccess(res, 200, updatedSession)
})

export const sendMessageStream = catchAsync(async (req: Request, res: Response) => {
  const { projectId, userId } = await authorizeProject(req)
  const chatId = requireChatId(req)
  await chatSessionService.assertChatSessionOwnership(projectId, chatId)

  const { content, step, discoveryStep } = req.body

  if (!content) {
    throw new ApiError(400, "Vui lòng nhập nội dung tin nhắn.", "CONTENT_REQUIRED")
  }
  if (!step) {
    throw new ApiError(400, "Thiếu thông tin bước đang làm.", "STEP_REQUIRED")
  }
  const knowledge = knowledgeFlagOf(req.body)

  // Mode 1 đã import (v3, BPMN 3.1): lệnh sửa trong chat ⇒ 409 CHANGE_REQUIRES_CR kèm form điền sẵn (yêu cầu miệng).
  // Câu hỏi tri thức (FLF-267) không sửa tài liệu ⇒ không qua chốt này.
  if (!knowledge && isChangeInstruction(content) && (await changesRequireCr(projectId))) throw chatChangeRequiresCr(chatId, content)

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
    discoveryStep ? Number(discoveryStep) : undefined,
    { knowledge }
  )
})

export const deleteChatSession = catchAsync(async (req: Request, res: Response) => {
  const { projectId } = await authorizeProject(req)
  const chatId = requireChatId(req)
  await chatSessionService.assertChatSessionOwnership(projectId, chatId)

  await chatSessionService.deleteChatSession(chatId)
  return sendSuccess(res, 200, { message: "Chat session deleted successfully" })
})
