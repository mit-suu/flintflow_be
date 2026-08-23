import mongoose from "mongoose"
import { ChatSession, IChatSession, IChatMessage } from "./chat-session.model.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { buildDocumentContext } from "../../shared/ai/document-context.service.js"
import { getPromptTemplate } from "../../shared/ai/prompt-registry.service.js"

export const createChatSession = async (projectId: string): Promise<IChatSession> => {
  // Deactivate other chat sessions for this project first
  await ChatSession.updateMany({ projectId }, { isActive: false })
  
  return await ChatSession.create({
    projectId: new mongoose.Types.ObjectId(projectId),
    messages: [],
    isActive: true
  })
}

export const getChatSessions = async (projectId: string): Promise<IChatSession[]> => {
  return await ChatSession.find({ projectId }).sort({ createdAt: -1 })
}

export const getChatSessionById = async (chatSessionId: string): Promise<IChatSession> => {
  const session = await ChatSession.findById(chatSessionId)
  if (!session) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }
  return session
}

import { SECTION_METADATA } from "../../shared/constants/section-types.js"


export const sendMessageAndGetResponse = async (
  projectId: string,
  chatSessionId: string,
  content: string,
  step: string,
  userId: string
): Promise<IChatSession> => {
  const session = await ChatSession.findById(chatSessionId)
  if (!session) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }

  // 1. Add user message
  const userMsg: IChatMessage = {
    role: "user",
    content,
    step,
    createdAt: new Date()
  }
  session.messages.push(userMsg)
  await session.save()

  // 2. Format history for AI context (last 10 messages of this step or general)
  const historyText = session.messages
    .slice(-12) // take last 12 messages for context
    .map((msg) => {
      const roleLabel = msg.role === "user" ? "User" : "AI"
      let text = msg.content
      // If AI message is JSON, try to extract the reply text
      if (msg.role === "ai" && text.startsWith("{") && text.endsWith("}")) {
        try {
          const parsed = JSON.parse(text)
          text = parsed.reply || text
        } catch (_) {}
      }
      return `${roleLabel}: ${text}`
    })
    .join("\n")

  // 3. Execute AI Action with Document Context
  const stepName = (SECTION_METADATA as any)[step]?.label || step

  // Task 2c: Build document context cho CHAT action
  // Tính chatHistoryTokens từ history hiện tại trước khi gọi AI
  const historyTokens = Math.ceil(historyText.length / 4)
  const chatTemplate = await getPromptTemplate(ActionType.CHAT)
  const docContext = await buildDocumentContext(
    projectId,
    ActionType.CHAT,
    undefined,       // CHAT không phải GENERATE_SECTION nên không cần sectionType
    historyTokens,
    chatTemplate.providerConfig.model,
    chatTemplate.providerConfig.maxTokens
  )

  let aiResult
  try {
    aiResult = await executeAiAction(
      ActionType.CHAT,
      {
        promptVariables: {
          step_name: stepName,
          chat_history: historyText || "Không có lịch sử trước đó.",
          input_text: content,
          documentContext: docContext.contextText  // rỗng nếu không cần
        }
      },
      projectId,
      userId
    )
  } catch (error: any) {
    console.error("AI action failed in chat session service:", error)
    // Fallback response on error
    const errorReply = {
      reply: "Rất tiếc, hệ thống gặp gián đoạn khi kết nối với AI. Vui lòng kiểm tra ví credit hoặc thử lại sau.",
      suggestedQuestions: ["Thử lại", "Bỏ qua"]
    }
    const aiErrorMsg: IChatMessage = {
      role: "ai",
      content: JSON.stringify(errorReply),
      step,
      createdAt: new Date()
    }
    session.messages.push(aiErrorMsg)
    await session.save()
    return session
  }

  // 4. Add AI response to history
  // aiResult.data should be parsed by response-parser to match chatSchema { reply, suggestedQuestions }
  const aiMsg: IChatMessage = {
    role: "ai",
    content: JSON.stringify(aiResult.data),
    step,
    createdAt: new Date()
  }
  session.messages.push(aiMsg)
  await session.save()

  return session
}

export const deleteChatSession = async (chatSessionId: string): Promise<void> => {
  const result = await ChatSession.deleteOne({ _id: chatSessionId })
  if (result.deletedCount === 0) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }
}

