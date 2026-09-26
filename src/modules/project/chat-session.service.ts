import mongoose from "mongoose"
import { Response } from "express"
import { ChatSession, IChatSession, IChatMessage } from "./chat-session.model.js"
import { executeAiAction, executeAiActionStream } from "../../shared/ai/ai-action.service.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { buildDocumentContext } from "../../shared/ai/document-context.service.js"
import { getPromptTemplate } from "../../shared/ai/prompt-registry.service.js"
import * as changeService from "../spine/change.service.js"
import { submitAnswer } from "../pipeline/step-runner.service.js"
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

/**
 * T17 (E4): tin nhắn dạng **lệnh sửa** đi qua change flow, không qua CHAT. Nó được dịch thành preview
 * diff + phạm vi ảnh hưởng; user xác nhận ở Change panel (`POST /changes` kèm `preview_id`). Ở đây KHÔNG
 * ghi Spine và KHÔNG đụng `progress` — chat không đẩy tiến độ (bất biến 7, srs-spine §6).
 *
 * FLF-201 (BUG-09): trước đây luật này chỉ áp cho session KHÔNG pipeline, nên trong session pipeline một
 * câu "thêm UC nhắc lịch đi" rơi vào CHAT thường: model trả lời "Tôi sẽ bổ sung UC18, UC19" mà không có
 * op nào, còn Spine vẫn 17 UC. Nay mọi session đều đi qua đây — câu trả lời là một bản xem trước thật,
 * hoặc một câu hỏi làm rõ, chứ không phải lời hứa. Lượt chờ `answer_needed` của step vẫn được ưu tiên
 * trước (kiểm ở `tryAnswerRunningStep`, chạy trước hàm này).
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
  if (!changeService.isChangeInstruction(content)) return null

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

/**
 * T20 (audit B2, E4): session PIPELINE đang chờ `answer_needed` của một step thì tin nhắn của user là
 * **câu trả lời cho step đó**, không phải một lượt CHAT mới. Chuyển thẳng vào hàng chờ của step runner
 * (`submitAnswer`) — luồng SSE của `/run` đang mở sẽ tiếp tục và ghi op.
 *
 * `submitAnswer` trả `false` khi không có lượt chờ nào khớp; khi đó tin nhắn đi tiếp đường CHAT như cũ.
 * Trước T20, Discovery đi qua `CHAT_DISCOVERY` và để LLM tự đánh giá đã đủ thông tin chưa, còn Brief chỉ
 * nằm trong JSON của tin nhắn — không có gì vào Spine.
 */
const tryAnswerRunningStep = async (session: IChatSession, projectId: string, content: string): Promise<boolean> => {
  if (!session.is_pipeline) return false
  const record = await spineRepository.get(projectId)
  const stepId = record?.progress.current_step
  if (!stepId) return false
  return submitAnswer(projectId, stepId, String(session._id), [{ question_id: "Q1", answer: content }])
}

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

  // T20: Discovery KHÔNG còn là một chế độ chat. B-0…B-2 là 13 step chạy qua step runner và ghi Spine
  // bằng op; `discoveryStep` chỉ còn là nhãn lưu vào transcript cho tương thích ngược.

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

  // 1b. T20: session pipeline đang chờ câu trả lời của step ⇒ tin nhắn là câu trả lời, không phải CHAT
  if (await tryAnswerRunningStep(session, projectId, content)) return session

  // 1c. T17: lệnh sửa từ session không pipeline đi vào change flow, không gọi CHAT
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

  // 3. Chỉ còn một loại chat
  const actionType = ActionType.CHAT

  // 4. Build step name and document context
  const stepName = step

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

  // 1b. T20: session pipeline đang chờ câu trả lời của step ⇒ đưa vào hàng chờ rồi đóng luồng này
  if (await tryAnswerRunningStep(session, projectId, content)) {
    try {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "finish", session, data: { reply: "" }, tokensUsed: null, cost: 0 })}\n\n`)
        res.end()
      }
    } catch (_) {}
    return
  }

  // 1c. T17: lệnh sửa từ session không pipeline đi vào change flow — trả một sự kiện rồi đóng luồng
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

  // 3. T20: chỉ còn một loại chat — Discovery đi qua step runner
  const actionType = ActionType.CHAT

  // 4. Build step name and doc context
  const stepName = step
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
