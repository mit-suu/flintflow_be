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
import { byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"
import type { ChangePreviewResult } from "./change.service.js"
import type { Spine } from "./spine.types.js"
import { buildConversationSummary, type TranscriptMessage } from "../pipeline/conversation-summary.js"

/** `buildConversationSummary` trả chuỗi này khi chưa có gì để tóm tắt. */
const EMPTY_SUMMARY = "(chưa có gì)"

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

/**
 * Ngữ cảnh hội thoại cho CHAT và lệnh sửa (FLF-244): đuôi `tail` tin như `formatChatHistory`, đứng sau một bản tóm tắt
 * có trần (ý tưởng, mục tiêu, điều đã chốt, lời user ở phần đã trôi khỏi đuôi) — phiên dài không làm AI quên mạch.
 * `messages` là phần TRƯỚC lượt hiện tại: tin đang gửi đã có ở `input_text`/`instruction`. Không có Spine ⇒ chỉ đuôi.
 */
export const formatChatContext = (
  messages: readonly IChatMessage[],
  spine: (Pick<Spine, "project" | "decisions"> & Partial<Pick<Spine, "addendum">>) | null,
  tail = CHAT_HISTORY_TAIL
): string => {
  const history = formatChatHistory(messages, tail)
  if (!spine) return history
  const older: TranscriptMessage[] = messages.slice(0, -tail).map((m) => ({ role: m.role, content: m.content }))
  const summary = buildConversationSummary(spine, older)
  if (summary === EMPTY_SUMMARY) return history
  return history ? `Tóm tắt hội thoại trước: ${summary}\n\n${history}` : `Tóm tắt hội thoại trước: ${summary}`
}

/**
 * Tin "đã áp dụng" của bản sửa một phần (lệnh nhiều ý còn một câu hỏi chờ trả lời): không khép yêu cầu đang hỏi dở, nên
 * `clarificationRounds` / `pendingChangeRequest` đi qua nó để câu trả lời kế tiếp vẫn nối với yêu cầu gốc.
 */
const keepsRequestOpen = (msg: IChatMessage): boolean => {
  if (msg.role !== "ai" || !msg.content.startsWith("{")) return false
  try {
    const data = JSON.parse(msg.content) as { kind?: unknown; request_open?: unknown }
    return data.kind === "change_applied" && data.request_open === true
  } catch {
    return false
  }
}

const messageKind = (msg: IChatMessage): string | null => {
  if (msg.role !== "ai" || !msg.content.startsWith("{")) return null
  try {
    const kind = (JSON.parse(msg.content) as { kind?: unknown }).kind
    return typeof kind === "string" ? kind : null
  } catch {
    return null
  }
}

/**
 * FLF-299: số câu hỏi làm rõ AI đã hỏi liên tiếp cho yêu cầu sửa đang dở — đếm từ cuối phiên lùi về, bỏ qua tin user,
 * dừng ở tin AI đầu tiên không phải `change_clarification` (một lượt khác đã khép yêu cầu trước).
 */
export const clarificationRounds = (messages: readonly IChatMessage[]): number => {
  let rounds = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") continue
    if (keepsRequestOpen(msg)) continue
    if (messageKind(msg) !== "change_clarification") break
    rounds++
  }
  return rounds
}

/**
 * P08 (T7): yêu cầu gốc đang được hỏi lại — câu lệnh của user đứng trước chuỗi câu hỏi làm rõ cuối phiên, kèm câu hỏi
 * gần nhất. Lượt trả lời ("Đúng, thêm mốc 3 tháng") mang theo hai câu này để model không coi câu trả lời là một lệnh mới
 * đứng một mình. Không có câu hỏi đang chờ ⇒ `null`.
 */
export const pendingChangeRequest = (messages: readonly IChatMessage[]): { request: string; question: string } | null => {
  let question: string | null = null
  let request: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") {
      request = msg.content
      continue
    }
    if (keepsRequestOpen(msg)) continue
    if (messageKind(msg) !== "change_clarification") break
    question ??= messageText(msg)
    request = null
  }
  return question && request?.trim() ? { request: request.trim(), question } : null
}

/** Phiên chat của đúng project này — sai project hay không tồn tại đều 404 (không lộ chatId của project khác). */
export const loadProjectSession = async (projectId: string, sessionId: string): Promise<IChatSession> => {
  const session = mongoose.isValidObjectId(sessionId) ? await ChatSession.findById(sessionId) : null
  if (!session || String(session.projectId) !== String(projectId)) {
    throw new ApiError(404, "Không tìm thấy phiên trò chuyện.", "CHAT_SESSION_NOT_FOUND")
  }
  return session
}

/**
 * Tin AI mô tả kết quả xem trước — cùng shape `ChatBubble` (FE) đang đọc. Chỉ lưu số thay đổi, không lưu mảng
 * `changes`/`impact`/`violations` (FLF-244): cả phiên nằm trong một document 16MB, còn bản xem trước thật nằm ở
 * `previewStore` (`change.service.ts`) theo `preview_id` — không ai đọc lại các mảng đó từ transcript.
 * FLF-260: câu cố định theo `language` của lượt; câu hỏi làm rõ đã đúng ngôn ngữ từ change.service.
 */
export const previewPayload = (
  preview: ChangePreviewResult,
  language: ReplyLanguage = "vi",
  /** FLF-318: dự án sau baseline (mode 1, `meta.requires_cr`) — bản xem trước để tạo change request, không áp thẳng. */
  opts: { requiresCr?: boolean } = {}
): Record<string, unknown> =>
  preview.auto_applied
    ? {
        // Mức duyệt cho phép tự ghi: tin vào phiên như một lượt đã áp, FE hiện nút hoàn tác
        kind: "change_applied",
        reply: [
          byLanguage(language, {
            vi: `Đã tự áp dụng ${preview.changes.length} thay đổi vào tài liệu theo mức duyệt của bạn - chưa ưng thì hoàn tác ngay được.`,
            en: `Applied ${preview.changes.length} change${preview.changes.length === 1 ? "" : "s"} to the document automatically, per your review level - undo right away if it is not what you wanted.`
          }),
          preview.notes
        ]
          .filter(Boolean)
          .join("\n"),
        count: preview.changes.length,
        spine_version: preview.applied_version ?? null,
        auto_applied: true
      }
    : preview.clarification
    ? {
        kind: "change_clarification",
        reply: [
          preview.clarification,
          // Lệnh nhiều ý: phần rõ đã có bản xem trước đi kèm câu hỏi này
          preview.ok && preview.changes.length > 0
            ? byLanguage(language, {
                vi: `Phần đã rõ mình dựng sẵn ${preview.changes.length} thay đổi ở bản xem trước - bạn trả lời câu này để mình làm nốt phần còn lại.`,
                en: `I built a preview of ${preview.changes.length} change${preview.changes.length === 1 ? "" : "s"} for the clear part - answer this and I will do the rest.`
              })
            : null,
          preview.ok ? preview.notes : null
        ]
          .filter(Boolean)
          .join("\n"),
        ...(preview.ok && preview.preview_id ? { preview_id: preview.preview_id, branch: preview.branch ?? null, change_count: preview.changes.length } : {}),
        // FLF-311: câu có lựa chọn (màn riêng / popup) ⇒ FE hiện thẻ chọn nhanh; chọn xong đi tiếp lệnh sửa
        ...(preview.clarification_choices?.length
          ? { questions: [{ question: byLanguage(language, { vi: "Chọn giao diện", en: "Choose the UI" }), options: preview.clarification_choices.map((label) => ({ label })) }] }
          : {})
      }
    : {
        kind: "change_preview",
        reply: preview.ok
          ? preview.changes.length > 0
            ? [
                opts.requiresCr
                  ? byLanguage(language, {
                      vi: `Đã dựng bản xem trước ${preview.changes.length} thay đổi - xem rồi bấm “Tạo change request” để gửi thay đổi này.`,
                      en: `Built a preview of ${preview.changes.length} change${preview.changes.length === 1 ? "" : "s"} - review it, then press "Tạo change request" (Create change request) to send it.`
                    })
                  : byLanguage(language, {
                      vi: `Đã dựng bản xem trước ${preview.changes.length} thay đổi - xem rồi bấm Áp dụng để ghi.`,
                      en: `Built a preview of ${preview.changes.length} change${preview.changes.length === 1 ? "" : "s"} - review it, then press "Áp dụng" (Apply) to save.`
                    }),
                // AI cảnh báo yêu cầu không hợp lý: nói thẳng trong chat, người dùng quyết "Vẫn làm" hay bỏ
                preview.warning
                  ? `${preview.warning} ${byLanguage(language, { vi: 'Nếu vẫn muốn làm, bấm “Vẫn làm”.', en: 'If you still want it, press "Vẫn làm" (Do it anyway).' })}`
                  : null,
                // FLF-298: phần còn thiếu (vd use case mới chưa có màn hình) phải hiện ngay trong chat, không chỉ trong thẻ
                preview.notes
              ]
                .filter(Boolean)
                .join("\n")
            : // Không có thay đổi mà có ghi chú (vd người dùng rút lại yêu cầu) ⇒ nói đúng ghi chú đó
              preview.notes ||
              byLanguage(language, {
                vi: "Không tìm thấy chỗ nào cần đổi theo lệnh này.",
                en: "Nothing in the document needs to change for this request."
              })
          : violationMessage(preview.violations),
        preview_id: preview.preview_id ?? null,
        branch: preview.branch ?? null,
        change_count: preview.changes.length,
        ...(preview.warning ? { warning: preview.warning } : {}),
        ...(preview.predicted_red_flags?.length ? { predicted_red_count: preview.predicted_red_flags.length } : {}),
        ...(preview.confirm_reason ? { confirm_reason: preview.confirm_reason } : {})
      }

/**
 * FLF-318: bản xem trước đã thành change request (`POST /change-requests` kèm `preview_id`) ⇒ tin bản xem trước trong phiên
 * đổi thành `change_cr` (mã CR + số thay đổi) — không còn trông như một lần sửa đang chờ xác nhận. Không tìm thấy ⇒ không
 * làm gì (bản xem trước dựng ngoài phiên chat).
 */
export const markPreviewAsCr = async (projectId: string, previewId: string, crId: string): Promise<number> => {
  const needle = `"preview_id":"${previewId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`
  const sessions = await ChatSession.find({ projectId, "messages.content": { $regex: needle } })
  let marked = 0
  for (const session of sessions) {
    let changed = false
    for (const message of session.messages) {
      if (message.role !== "ai") continue
      let data: { kind?: unknown; preview_id?: unknown; change_count?: unknown; reply?: unknown }
      try {
        data = JSON.parse(message.content) as typeof data
      } catch {
        continue
      }
      if (data.kind !== "change_preview" || data.preview_id !== previewId) continue
      const count = typeof data.change_count === "number" ? data.change_count : 0
      const english = typeof data.reply === "string" && data.reply.startsWith("Built")
      message.content = JSON.stringify({
        kind: "change_cr",
        reply: english
          ? `Created ${crId} from this preview (${count} change${count === 1 ? "" : "s"}) - follow and confirm it in the change request.`
          : `Đã tạo ${crId} từ bản xem trước này (${count} thay đổi) - theo dõi và xác nhận trong change request.`,
        cr_id: crId,
        preview_id: previewId,
        change_count: count
      })
      changed = true
      marked += 1
    }
    if (changed) {
      session.markModified("messages")
      await session.save()
    }
  }
  return marked
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
