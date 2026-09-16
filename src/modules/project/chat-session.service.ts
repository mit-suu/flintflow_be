import mongoose from "mongoose"
import { Response } from "express"
import { ChatSession, IChatSession, IChatMessage } from "./chat-session.model.js"
import { executeAiAction, executeAiActionStream } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { buildDocumentContext } from "../../shared/ai/document-context.service.js"
import { getPromptTemplate } from "../../shared/ai/prompt-registry.service.js"
import * as changeService from "../spine/change.service.js"
import * as spineRepository from "../spine/spine.repository.js"

export const createChatSession = async (projectId: string): Promise<IChatSession> => {
  // T13: không tắt (isActive) session khác của project — nhiều session chat (không pipeline) có thể
  // tồn tại song song, chỉ đúng một session giữ is_pipeline (bất biến 7, srs-spine.md §6).
  const base = {
    projectId: new mongoose.Types.ObjectId(projectId),
    messages: [],
    isActive: true
  }

  // Session đầu tiên của project giữ cờ pipeline (srs-spine.md §6 bất biến 7)
  const hasPipeline = await ChatSession.exists({ projectId, is_pipeline: true })
  if (hasPipeline) {
    return await ChatSession.create({ ...base, is_pipeline: false })
  }

  try {
    return await ChatSession.create({ ...base, is_pipeline: true })
  } catch (err) {
    // Hai request tạo session đầu cùng lúc: bên thua dính unique index → session thường
    const isDuplicateKey = typeof err === "object" && err !== null && "code" in err && err.code === 11000
    if (!isDuplicateKey) throw err
    return await ChatSession.create({ ...base, is_pipeline: false })
  }
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

/**
 * F5 (review T13, IDOR): mọi route `/projects/:projectId/chats/:chatId*` phải xác nhận `chatId` THẬT SỰ
 * thuộc `projectId` trên đường dẫn — trước đây `getChatSessionById`/`deleteChatSession`/`sendMessage*` chỉ
 * tra theo `chatId`, không đối chiếu `projectId`, nên một user sở hữu project A đoán được `chatId` của
 * project B (không phải của mình) vẫn đọc/xoá/gửi tin được. 404 `CHAT_SESSION_NOT_FOUND` (không phải 403)
 * để không lộ việc chatId đó có tồn tại hay không, cùng pattern các module khác trong repo.
 */
export const assertChatSessionOwnership = async (projectId: string, chatSessionId: string): Promise<IChatSession> => {
  const session = await ChatSession.findById(chatSessionId)
  if (!session || String(session.projectId) !== String(projectId)) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }
  return session
}

import { SECTION_METADATA } from "../../shared/constants/section-types.js"
import { Project } from "./project.model.js"
import { Section, SectionType } from "../specification/section.model.js"
import { SectionVersion } from "../specification/section-version.model.js"
import { calculateProgress } from "../specification/phase-gate.service.js"

/**
 * T17 (E4): session KHÔNG pipeline vẫn được sửa SRS — nhưng phải đi qua change flow, không qua CHAT.
 * Tin nhắn dạng lệnh sửa được dịch thành preview diff + phạm vi ảnh hưởng; user xác nhận ở Change panel
 * (`POST /changes` kèm `preview_id`). Ở đây KHÔNG ghi Spine và KHÔNG đụng `progress` — session không
 * pipeline không đẩy tiến độ (bất biến 7, srs-spine §6).
 *
 * Trả về tin nhắn AI đã ghi vào transcript, hoặc `null` khi tin nhắn không phải lệnh sửa (đi tiếp CHAT).
 */
const tryChangeFlow = async (
  session: IChatSession,
  projectId: string,
  content: string,
  step: string,
  userId: string
): Promise<IChatMessage | null> => {
  if (session.is_pipeline || !changeService.isChangeInstruction(content)) return null

  const record = await spineRepository.get(projectId)
  if (!record) return null

  let payload: Record<string, unknown>
  try {
    const preview = await changeService.preview(projectId, userId, { instruction: content, base_version: record.spine_version })
    payload = preview.clarification
      ? { kind: "change_clarification", reply: preview.clarification }
      : {
          kind: "change_preview",
          reply: preview.ok
            ? `Đã dựng bản xem trước ${preview.changes.length} thay đổi. Mở Change panel để xem diff rồi xác nhận.`
            : "Không áp được thay đổi này — xem chi tiết vi phạm trong Change panel.",
          preview_id: preview.preview_id ?? null,
          branch: preview.branch ?? null,
          changes: preview.changes,
          impact: preview.impact ?? null,
          violations: preview.violations
        }
  } catch (err) {
    // Lệnh sửa lỗi (hết credit, xung đột version…) không được làm hỏng phiên chat
    const message = err instanceof ApiError ? err.message : "Không xử lý được yêu cầu sửa lúc này."
    payload = { kind: "change_error", reply: message }
  }

  const aiMsg: IChatMessage = { role: "ai", content: JSON.stringify(payload), step, createdAt: new Date() }
  session.messages.push(aiMsg)
  await session.save()
  return aiMsg
}

export const sendMessageAndGetResponse = async (
  projectId: string,
  chatSessionId: string,
  content: string,
  step: string,
  userId: string,
  discoveryStep?: number,
  workspacePhase?: string
): Promise<IChatSession> => {
  const session = await ChatSession.findById(chatSessionId)
  if (!session) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }

  // T13: session không pipeline chỉ dùng để hỏi đáp (CHAT) — không cho chạy Discovery qua chat cũ,
  // pipeline B-0…B-2 đi qua step-runner (session is_pipeline). Xem coding-rules mục "Sửa chat-session".
  const isDiscoveryMode = session.is_pipeline && discoveryStep && discoveryStep >= 1 && discoveryStep <= 6
  const currentWorkspacePhase = isDiscoveryMode ? "discovery" : (workspacePhase || "product_overview")

  // 1. Add user message
  const userMsg: IChatMessage = {
    role: "user",
    content,
    step,
    discoveryStep,
    workspacePhase: currentWorkspacePhase,
    createdAt: new Date()
  }
  session.messages.push(userMsg)
  await session.save()

  // 1b. T17: lệnh sửa từ session không pipeline đi vào change flow, không gọi CHAT
  if (await tryChangeFlow(session, projectId, content, step, userId)) return session

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
      questions: []
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
      workspacePhase: currentWorkspacePhase,
      createdAt: new Date()
    }
    session.messages.push(aiErrorMsg)
    await session.save()
    return session
  }

  // 7. Add AI response to history
  const contentToStore = typeof aiResult.data === "string"
    ? aiResult.data
    : JSON.stringify(aiResult.data)

  const aiMsg: IChatMessage = {
    role: "ai",
    content: contentToStore,
    step,
    discoveryStep,
    workspacePhase: currentWorkspacePhase,
    createdAt: new Date()
  }
  session.messages.push(aiMsg)
  await session.save()

  return session
}

export const sendMessageStream = async (
  projectId: string,
  chatSessionId: string,
  content: string,
  step: string,
  userId: string,
  res: Response,
  discoveryStep?: number
): Promise<void> => {
  const session = await ChatSession.findById(chatSessionId)
  if (!session) {
    res.write(`data: ${JSON.stringify({ type: "error", error: "Chat session not found" })}\n\n`)
    res.end()
    return
  }

  // 1. Add user message to session & save
  const userMsg: IChatMessage = {
    role: "user",
    content,
    step,
    discoveryStep,
    createdAt: new Date()
  }
  session.messages.push(userMsg)
  await session.save()

  // 1b. T17: lệnh sửa từ session không pipeline đi vào change flow — trả một sự kiện rồi đóng luồng
  const changeMsg = await tryChangeFlow(session, projectId, content, step, userId)
  if (changeMsg) {
    // Dùng đúng sự kiện `finish` như luồng CHAT (không stream chữ) để FE không phải biết thêm loại event
    try {
      if (!res.destroyed && !res.writableEnded) {
        const payload: unknown = JSON.parse(changeMsg.content)
        res.write(`data: ${JSON.stringify({ type: "finish", session, data: payload, tokensUsed: null, cost: 0 })}

`)
        res.end()
      }
    } catch (_) {}
    return
  }

  // 2. Format history for AI context (last 12 messages)
  const historyText = session.messages
    .slice(-12)
    .map((msg) => {
      const roleLabel = msg.role === "user" ? "User" : "AI"
      let text = msg.content
      if (msg.role === "ai" && text.startsWith("{") && text.endsWith("}")) {
        try {
          const parsed = JSON.parse(text)
          text = parsed.reply || text
        } catch (_) {}
      }
      return `${roleLabel}: ${text}`
    })
    .join("\n")

  // 3. Determine ActionType: Discovery chat vs regular chat — T13: session không pipeline chỉ CHAT.
  const isDiscoveryMode = session.is_pipeline && discoveryStep && discoveryStep >= 1 && discoveryStep <= 6
  const actionType = isDiscoveryMode ? ActionType.CHAT_DISCOVERY : ActionType.CHAT

  // 4. Build step name and doc context
  const stepName = (SECTION_METADATA as any)[step]?.label || step
  const historyTokens = Math.ceil(historyText.length / 4)
  const chatTemplate = await getPromptTemplate(actionType)
  const docContext = await buildDocumentContext(
    projectId,
    ActionType.CHAT,
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

  if (isDiscoveryMode) {
    promptVariables.discovery_step = String(discoveryStep)
    promptVariables.completed_steps_summary = buildCompletedStepsSummary(session.messages)
  }

  // 6. Execute stream with Vercel AI SDK
  try {
    const aiResult = await executeAiActionStream(
      actionType,
      { promptVariables },
      projectId,
      userId,
      {
        onTextDelta: (delta: string) => {
          try {
            if (!res.destroyed && !res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "text-delta", delta })}\n\n`)
            }
          } catch (_) {}
        }
      }
    )

    // 7. Add AI response to MongoDB history
    const contentToStore = typeof aiResult.data === "string"
      ? aiResult.data
      : JSON.stringify(aiResult.data)

    const aiMsg: IChatMessage = {
      role: "ai",
      content: contentToStore,
      step,
      discoveryStep,
      createdAt: new Date()
    }
    session.messages.push(aiMsg)
    await session.save()

    // 8. Send finish event with updated session and parsed data
    try {
      if (!res.destroyed && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            type: "finish",
            session,
            data: aiResult.data,
            tokensUsed: aiResult.tokensUsed,
            cost: aiResult.cost
          })}\n\n`
        )
        res.end()
      }
    } catch (_) {}
  } catch (error: any) {
    console.error("AI stream failed in chat session service:", error)
    try {
      if (!res.destroyed && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            type: "error",
            error: error.message || "AI generation failed"
          })}\n\n`
        )
        res.end()
      }
    } catch (_) {}
  }
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

/**
 * Xoá session. Nếu session xoá đang giữ `is_pipeline` (bất biến 7): promote session gần nhất còn lại
 * (theo `createdAt`) thành pipeline, để project luôn có đúng một session pipeline khi còn session nào đó.
 */
export const deleteChatSession = async (chatSessionId: string): Promise<void> => {
  const target = await ChatSession.findById(chatSessionId, { projectId: 1, is_pipeline: 1 })
  if (!target) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }

  const result = await ChatSession.deleteOne({ _id: chatSessionId })
  if (result.deletedCount === 0) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }

  if (target.is_pipeline) {
    const next = await ChatSession.findOne({ projectId: target.projectId }).sort({ createdAt: -1 })
    if (next) await ChatSession.updateOne({ _id: next._id }, { is_pipeline: true })
  }
}

export interface RollbackResult {
  session: IChatSession
  project: any
  sections: any[]
  workspacePhase: string
}

export const rollbackMessages = async (
  chatSessionId: string,
  messageIndex: number
): Promise<RollbackResult> => {
  const session = await ChatSession.findById(chatSessionId)
  if (!session) {
    throw new ApiError(404, "Chat session not found", "CHAT_SESSION_NOT_FOUND")
  }

  if (
    typeof messageIndex !== "number" ||
    messageIndex < 0 ||
    messageIndex >= session.messages.length
  ) {
    throw new ApiError(400, "Invalid message index for rollback", "INVALID_MESSAGE_INDEX")
  }

  const project = await Project.findById(session.projectId)
  if (!project) {
    throw new ApiError(404, "Project not found", "PROJECT_NOT_FOUND")
  }

  // 1. Cắt bỏ tin nhắn được chọn và toàn bộ các tin nhắn sau nó
  const remainingMsgs = session.messages.slice(0, messageIndex)
  session.messages = remainingMsgs
  await session.save()

  // 2. Xác định workspacePhase mục tiêu sau khi rollback
  let targetPhase: "discovery" | "product_overview" | "functional_spec" | "nfr_appendix" | "export" = "discovery"

  if (remainingMsgs.length === 0) {
    targetPhase = "discovery"
  } else {
    // Quét từ tin nhắn cuối cùng còn lại ngược về trước
    for (let i = remainingMsgs.length - 1; i >= 0; i--) {
      const msg = remainingMsgs[i]
      if (msg.workspacePhase) {
        targetPhase = msg.workspacePhase as any
        break
      }
      if (msg.discoveryStep) {
        targetPhase = "discovery"
        break
      }
      if (msg.role === "ai") {
        try {
          const parsed = JSON.parse(msg.content)
          if (parsed.evaluation?.currentStep) {
            targetPhase = "discovery"
            break
          }
        } catch (_) {}
      }
    }
  }

  // 3. Xử lý xóa các Section đã sinh ra tương ứng và cập nhật Project
  if (targetPhase === "discovery") {
    // Khi hoàn tác về Discovery: Xóa TOÀN BỘ các Section đã sinh ra
    const sectionsToDelete = await Section.find({ projectId: project._id })
    const sectionIds = sectionsToDelete.map((s) => s._id)
    if (sectionIds.length > 0) {
      await SectionVersion.deleteMany({ sectionId: { $in: sectionIds } })
      await Section.deleteMany({ projectId: project._id })
    }

    project.workspacePhase = "discovery"
    project.currentPhase = 2
    project.currentStep = "phase_2"
    project.progressPercent = 0
    project.baselineVersion = null
    await project.save()
  } else if (targetPhase === "product_overview") {
    // Khi hoàn tác về Product Overview: Xóa toàn bộ Section đã sinh ra của Product Overview và các phase sau
    const sectionsToDelete = await Section.find({ projectId: project._id })
    const sectionIds = sectionsToDelete.map((s) => s._id)
    if (sectionIds.length > 0) {
      await SectionVersion.deleteMany({ sectionId: { $in: sectionIds } })
      await Section.deleteMany({ projectId: project._id })
    }

    project.workspacePhase = "product_overview"
    project.currentPhase = 2
    project.currentStep = "phase_2"
    project.progressPercent = 0
    project.baselineVersion = null
    await project.save()
  } else if (targetPhase === "functional_spec") {
    // Khi hoàn tác về Functional Spec: Xóa các Section thuộc Phase 3 và Phase 4
    const phase3And4Types = Object.entries(SECTION_METADATA)
      .filter(([_, meta]) => meta.phase >= 3)
      .map(([type]) => type) as unknown as SectionType[]
    const sectionsToDelete = await Section.find({
      projectId: project._id,
      type: { $in: phase3And4Types }
    })
    const sectionIds = sectionsToDelete.map((s) => s._id)
    if (sectionIds.length > 0) {
      await SectionVersion.deleteMany({ sectionId: { $in: sectionIds } })
      await Section.deleteMany({
        projectId: project._id,
        type: { $in: phase3And4Types }
      })
    }

    project.workspacePhase = "functional_spec"
    project.currentPhase = 3
    project.currentStep = "phase_3"
    project.progressPercent = await calculateProgress(project._id.toString())
    project.baselineVersion = null
    await project.save()
  } else if (targetPhase === "nfr_appendix") {
    // Khi hoàn tác về NFR & Appendix: Xóa các Section thuộc Phase 4
    const phase4Types = Object.entries(SECTION_METADATA)
      .filter(([_, meta]) => meta.phase >= 4)
      .map(([type]) => type) as unknown as SectionType[]
    const sectionsToDelete = await Section.find({
      projectId: project._id,
      type: { $in: phase4Types }
    })
    const sectionIds = sectionsToDelete.map((s) => s._id)
    if (sectionIds.length > 0) {
      await SectionVersion.deleteMany({ sectionId: { $in: sectionIds } })
      await Section.deleteMany({
        projectId: project._id,
        type: { $in: phase4Types }
      })
    }

    project.workspacePhase = "nfr_appendix"
    project.currentPhase = 4
    project.currentStep = "phase_4"
    project.progressPercent = await calculateProgress(project._id.toString())
    project.baselineVersion = null
    await project.save()
  }

  // 4. Lấy danh sách section còn lại của project
  const remainingSections = await Section.find({ projectId: project._id }).sort({ order: 1 })

  return {
    session,
    project,
    sections: remainingSections,
    workspacePhase: project.workspacePhase
  }
}

