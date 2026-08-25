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
  userId: string,
  discoveryStep?: number
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
    discoveryStep,
    createdAt: new Date()
  }
  session.messages.push(userMsg)
  await session.save()

  // 2. Format history for AI context (last 12 messages)
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

  // 3. Determine ActionType: Discovery chat (with evaluation) vs regular chat
  const isDiscoveryMode = discoveryStep && discoveryStep >= 1 && discoveryStep <= 6
  const actionType = isDiscoveryMode ? ActionType.CHAT_DISCOVERY : ActionType.CHAT

  // 4. Build step name and document context
  const stepName = (SECTION_METADATA as any)[step]?.label || step

  const historyTokens = Math.ceil(historyText.length / 4)
  const chatTemplate = await getPromptTemplate(actionType)
  const docContext = await buildDocumentContext(
    projectId,
    ActionType.CHAT,       // Document context logic same for both chat types
    undefined,
    historyTokens,
    chatTemplate.providerConfig.model,
    chatTemplate.providerConfig.maxTokens
  )

  // 5. Build prompt variables
  const promptVariables: Record<string, any> = {
    step_name: stepName,
    chat_history: historyText || "Không có lịch sử trước đó.",
    input_text: content,
    documentContext: docContext.contextText
  }

  // Add discovery-specific variables
  if (isDiscoveryMode) {
    promptVariables.discovery_step = String(discoveryStep)
    promptVariables.completed_steps_summary = buildCompletedStepsSummary(session.messages)
  }

  // 6. Execute AI Action
  let aiResult
  try {
    aiResult = await executeAiAction(
      actionType,
      { promptVariables },
      projectId,
      userId
    )
  } catch (error: any) {
    console.error("AI action failed in chat session service:", error)
    // Fallback response on error
    const errorReply: any = {
      reply: "Rất tiếc, hệ thống gặp gián đoạn khi kết nối với AI. Vui lòng kiểm tra ví credit hoặc thử lại sau.",
      suggestedQuestions: ["Thử lại", "Bỏ qua"]
    }
    // Add minimal evaluation for discovery mode so FE doesn't break
    if (isDiscoveryMode) {
      errorReply.evaluation = {
        currentStep: discoveryStep,
        stepCompleteness: 0,
        isStepComplete: false,
        isDiscoveryComplete: false,
        recommendedAction: "continue_discussion",
        stepSummary: "",
        missingInfo: []
      }
    }
    const aiErrorMsg: IChatMessage = {
      role: "ai",
      content: JSON.stringify(errorReply),
      step,
      discoveryStep,
      createdAt: new Date()
    }
    session.messages.push(aiErrorMsg)
    await session.save()
    return session
  }

  // 7. Add AI response to history
  const aiMsg: IChatMessage = {
    role: "ai",
    content: JSON.stringify(aiResult.data),
    step,
    discoveryStep,
    createdAt: new Date()
  }
  session.messages.push(aiMsg)
  await session.save()

  return session
}

/**
 * Quét lịch sử chat để xây dựng tóm tắt các step đã covered.
 * Tìm các AI message có evaluation.stepSummary và gom lại.
 */
function buildCompletedStepsSummary(messages: IChatMessage[]): string {
  const stepSummaries: Record<number, string> = {}

  for (const msg of messages) {
    if (msg.role === "ai") {
      try {
        const parsed = JSON.parse(msg.content)
        if (parsed.evaluation?.stepSummary && parsed.evaluation?.currentStep) {
          stepSummaries[parsed.evaluation.currentStep] = parsed.evaluation.stepSummary
        }
      } catch (_) {}
    }
  }

  if (Object.keys(stepSummaries).length === 0) {
    return "Chưa có thông tin nào được thu thập."
  }

  const STEP_LABELS = [
    "", "Vision & Problem", "Users & JTBD", "Value Prop",
    "MVP Scope", "Metrics", "Risks & Questions"
  ]

  return Object.entries(stepSummaries)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([stepNum, summary]) => `Step ${stepNum} (${STEP_LABELS[Number(stepNum)]}): ${summary}`)
    .join("\n")
}

export const deleteChatSession = async (chatSessionId: string): Promise<void> => {
  const result = await ChatSession.deleteOne({ _id: chatSessionId })
  if (result.deletedCount === 0) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }
}

