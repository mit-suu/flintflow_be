import mongoose from "mongoose"
import { ChatSession } from "./chat-session.model.js"
import { accountLocaleOf } from "../user/account-locale.js"
import { isUserLocale } from "../../shared/i18n/locale.js"
import { detectMessageLanguage, resolveReplyLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"
import { stripRecommended } from "../pipeline/question-shape.js"

const labelKey = (label: string): string => stripRecommended(label).trim().toLowerCase()

/** Nhãn lựa chọn trong một tin AI đã lưu (JSON `{ reply, questions: [{ options: [{ label }] }] }`); tin khác ⇒ rỗng. */
const optionLabelsOf = (aiContent: string | null | undefined): Set<string> => {
  const labels = new Set<string>()
  if (!aiContent) return labels
  try {
    const parsed: unknown = JSON.parse(aiContent)
    const questions = (parsed as { questions?: unknown }).questions
    if (!Array.isArray(questions)) return labels
    for (const q of questions) {
      const options = (q as { options?: unknown }).options
      if (!Array.isArray(options)) continue
      for (const o of options) {
        const label = (o as { label?: unknown }).label
        if (typeof label === "string" && label.trim() !== "") labels.add(labelKey(label))
      }
    }
  } catch {
    // Tin AI dạng chữ thường (không phải JSON) ⇒ không có thẻ
  }
  return labels
}

/**
 * Phần user tự gõ trong một tin chat: bỏ các dòng chỉ là nhãn lựa chọn của thẻ AI vừa hỏi — FE gửi câu trả lời thẻ dạng
 * "nhãn", "1. nhãn" hay "nhãn; nhãn". Nhãn do AI viết: đoán trên đó thì một tên riêng tiếng Việt trong nhãn ("Bạch Mai
 * Hospital") đổi cả phiên tiếng Anh sang tiếng Việt.
 */
export const typedPartOf = (content: string, lastAiContent: string | null | undefined): string => {
  const labels = optionLabelsOf(lastAiContent)
  if (labels.size === 0) return content
  return content
    .split("\n")
    .filter((line) => {
      const parts = line
        .replace(/^\s*\d+\.\s*/, "")
        .split(";")
        .map(labelKey)
        .filter((part) => part !== "")
      return !(parts.length > 0 && parts.every((part) => labels.has(part)))
    })
    .join("\n")
}

/**
 * FLF-260 — ngôn ngữ AI trả lời cho một lượt, trên phiên đã nạp: tin user gõ rõ ngôn ngữ ⇒ theo tin đó và ghi lên
 * document (nơi gọi tự `save`); mơ hồ ⇒ ngôn ngữ phiên ⇒ ngôn ngữ tài khoản ⇒ tiếng Việt.
 *
 * Chỉ truyền `message` là chữ user tự gõ — không truyền chữ hệ thống tự ghi thay user ("Đúng rồi, đi tiếp"), không thì
 * một lần bấm chip là phiên đổi ngôn ngữ.
 */
export const replyLanguageForSession = async (
  session: { reply_language?: ReplyLanguage | null },
  message: string | null | undefined,
  userId: string | null | undefined
): Promise<ReplyLanguage> => {
  const detected = detectMessageLanguage(message)
  if (detected) {
    session.reply_language = detected
    return detected
  }
  if (isUserLocale(session.reply_language)) return session.reply_language
  // Phiên chưa có ngôn ngữ: câu tiếng Anh ngắn cũng là tín hiệu tốt hơn ngôn ngữ tài khoản
  const firstSignal = detectMessageLanguage(message, { lenient: true })
  if (firstSignal) {
    session.reply_language = firstSignal
    return firstSignal
  }
  return resolveReplyLanguage(await accountLocaleOf(userId))
}

/**
 * Như `replyLanguageForSession` nhưng theo id phiên — cho step runner, vốn không giữ document phiên. Tin rõ ngôn ngữ thì
 * ghi `reply_language` ngay. Chưa nối DB (unit test) hay đọc/ghi lỗi ⇒ bỏ qua phần phiên, vẫn trả ngôn ngữ hợp lý.
 */
export const replyLanguageForSessionId = async (input: {
  projectId: string
  sessionId: string | null | undefined
  userId: string | null | undefined
  message?: string | null
}): Promise<ReplyLanguage> => {
  const detected = detectMessageLanguage(input.message)
  const persist = async (language: ReplyLanguage, filter: { _id: string; projectId: string }): Promise<ReplyLanguage> => {
    await ChatSession.updateOne(filter, { $set: { reply_language: language } })
    return language
  }
  if (input.sessionId && mongoose.connection.readyState === 1) {
    try {
      const filter = { _id: input.sessionId, projectId: input.projectId }
      if (detected) return await persist(detected, filter)
      const session = await ChatSession.findOne(filter, { reply_language: 1 }).lean()
      if (isUserLocale(session?.reply_language)) return session.reply_language
      // Phiên chưa có ngôn ngữ: câu tiếng Anh ngắn cũng là tín hiệu tốt hơn ngôn ngữ tài khoản
      const firstSignal = detectMessageLanguage(input.message, { lenient: true })
      if (firstSignal) return await persist(firstSignal, filter)
    } catch (err) {
      console.warn("[replyLanguageForSessionId] Không đọc/ghi được ngôn ngữ của phiên:", err)
    }
  }
  return detected ?? detectMessageLanguage(input.message, { lenient: true }) ?? resolveReplyLanguage(await accountLocaleOf(input.userId))
}
