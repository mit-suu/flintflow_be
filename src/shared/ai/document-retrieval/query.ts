/**
 * Câu hỏi tìm đoạn cho lượt chat (FLF-393) — hàm thuần.
 */

import { tokenizeText } from "./vi-tokenizer.js"

/** Tin có ít hơn ngần này từ có nghĩa và không nhắc mã nào ("còn cái kia thì sao") thì mượn thêm vài lượt trước. */
export const SHORT_QUERY_WORDS = 3
/** Số lượt trước được ghép vào câu hỏi ngắn. */
export const QUERY_CONTEXT_TURNS = 2
const TURN_CHARS = 500

/**
 * Câu hỏi toàn cục ("tóm tắt tài liệu", "có bao nhiêu use case"): tìm đoạn không trả lời được, phải đọc tóm tắt / chỉ mục.
 * Gồm cả cách gõ không dấu.
 */
const GLOBAL_QUESTION =
  /tóm tắt|tom tat|tổng quan|tong quan|tổng kết|tong ket|khái quát|khai quat|toàn bộ|toan bo|tất cả|tat ca|bao nhiêu|bao nhieu|liệt kê|liet ke|nói về (cái )?gì|noi ve (cai )?gi|summar|overview|how many|list all|in general/i

export const isGlobalQuestion = (text: string): boolean => GLOBAL_QUESTION.test(text.normalize("NFC"))

export interface ChatTurn {
  role: string
  content: string
}

/** Tin AI có câu hỏi lưu dạng JSON `{ reply, questions }` ⇒ chỉ lấy `reply`. */
const turnText = (turn: ChatTurn): string => {
  if (turn.role !== "user" && turn.content.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(turn.content)
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { reply?: unknown }).reply === "string") {
        return (parsed as { reply: string }).reply
      }
    } catch {
      // tin thường
    }
  }
  return turn.content
}

/** Câu hỏi tìm đoạn = tin user; tin quá ngắn thì nối `QUERY_CONTEXT_TURNS` lượt liền trước (`history` không gồm tin này). */
export const chatDocumentQuery = (message: string, history: readonly ChatTurn[] = []): string => {
  const { wordCount, codes } = tokenizeText(message)
  if (wordCount >= SHORT_QUERY_WORDS || codes.length > 0) return message
  const context = history
    .slice(-QUERY_CONTEXT_TURNS)
    .map((t) => turnText(t).slice(0, TURN_CHARS))
    .filter(Boolean)
  return [message, ...context].join("\n")
}
