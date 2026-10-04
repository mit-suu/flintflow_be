/**
 * change-transcript.ts
 * ─────────────────────────────────────────────────────────────────
 * Lệnh sửa tài liệu (chip "Sửa tài liệu") là một lượt hội thoại như mọi tin nhắn khác: câu lệnh của user và
 * kết quả (bản xem trước / câu hỏi làm rõ / lỗi / đã áp) được ghi vào phiên chat, và model đọc đoạn cuối phiên
 * để hiểu lượt này đang nói tiếp chuyện gì — nhất là khi user trả lời câu hỏi làm rõ (UC 6.11). Trước đây mỗi
 * lệnh là một lượt gọi rời: câu trả lời cho câu hỏi làm rõ đến tay model như một lệnh mới, mất yêu cầu gốc.
 *
 * Chỉ nạp **đuôi** transcript (bounded), không nạp cả phiên — cùng mức với CHAT.
 */

import mongoose from "mongoose"
import { ChatSession, type IChatMessage, type IChatSession } from "../project/chat-session.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { AiActionError } from "../../shared/ai/ai-action.types.js"
import { toClientError, violationMessage } from "../../shared/utils/client-error.js"
import type { ChangePreviewResult } from "./change.service.js"

/** Số tin cuối phiên đưa vào prompt — cùng mức với CHAT. */
export const CHAT_HISTORY_TAIL = 12

/** Tin AI lưu dạng JSON (`{ kind, reply, … }`) ⇒ chỉ lấy `reply` cho model đọc. */
const messageText = (msg: IChatMessage): string => {
  const text = msg.content
  if (msg.role !== "ai" || !text.startsWith("{") || !text.endsWith("}")) return text
  try {
    const parsed = JSON.parse(text) as { reply?: unknown }
    return typeof parsed.reply === "string" && parsed.reply ? parsed.reply : text
  } catch {
    return text
  }
}

/** Đuôi transcript dạng `User: …` / `AI: …`, cũ trước mới sau. Rỗng khi phiên chưa có tin nào. */
export const formatChatHistory = (messages: readonly IChatMessage[], tail = CHAT_HISTORY_TAIL): string =>
  messages
    .slice(-tail)
    .map((msg) => `${msg.role === "user" ? "User" : "AI"}: ${messageText(msg)}`)
    .join("\n")

/** Phiên chat của đúng project này — sai project hay không tồn tại đều 404 (không lộ chatId của project khác). */
export const loadProjectSession = async (projectId: string, sessionId: string): Promise<IChatSession> => {
  const session = mongoose.isValidObjectId(sessionId) ? await ChatSession.findById(sessionId) : null
  if (!session || String(session.projectId) !== String(projectId)) {
    throw new ApiError(404, "Không tìm thấy phiên trò chuyện.", "CHAT_SESSION_NOT_FOUND")
  }
  return session
}

/** Tin AI mô tả kết quả xem trước — cùng shape `ChatBubble` (FE) đang đọc. */
export const previewPayload = (preview: ChangePreviewResult): Record<string, unknown> =>
  preview.clarification
    ? { kind: "change_clarification", reply: preview.clarification }
    : {
        kind: "change_preview",
        reply: preview.ok
          ? preview.changes.length > 0
            ? `Đã dựng bản xem trước ${preview.changes.length} thay đổi — xem rồi bấm Áp dụng để ghi.`
            : "Không tìm thấy chỗ nào cần đổi theo lệnh này."
          : violationMessage(preview.violations),
        preview_id: preview.preview_id ?? null,
        branch: preview.branch ?? null,
        changes: preview.changes,
        impact: preview.impact ?? null,
        violations: preview.violations
      }

/**
 * Câu của tin `change_error` trong phiên (FLF-247): lỗi op/bất biến/schema thành câu thường theo luật vi phạm
 * (`toClientError`), không còn path op hay dump Zod; câu hỏi làm rõ (NEEDS_CLARIFICATION) và câu đã thân thiện giữ
 * nguyên. Lỗi không rõ nguồn ⇒ câu chung — chi tiết đã được log ở nơi bắt lỗi.
 */
export const changeErrorReply = (err: unknown): string =>
  err instanceof ApiError || err instanceof AiActionError ? toClientError(err).message : "Không xử lý được yêu cầu sửa lúc này."

/**
 * Ghi một lượt vào phiên: tin user (nếu có) rồi tin AI. `step` theo tin cuối phiên để khung chat không chèn
 * vạch "bắt đầu bước" giữa chừng chỉ vì một lệnh sửa.
 */
export const recordChangeTurn = async (
  session: IChatSession,
  userText: string | null,
  payload: Record<string, unknown>
): Promise<IChatMessage> => {
  const step = session.messages[session.messages.length - 1]?.step ?? "chat"
  const now = new Date()
  if (userText) session.messages.push({ role: "user", content: userText, step, createdAt: now })
  const aiMsg: IChatMessage = { role: "ai", content: JSON.stringify(payload), step, createdAt: new Date(now.getTime() + 1) }
  session.messages.push(aiMsg)
  await session.save()
  return aiMsg
}
