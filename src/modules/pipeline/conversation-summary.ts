/**
 * conversation-summary.ts
 * ─────────────────────────────────────────────────────────────────
 * Trí nhớ hội thoại xuyên bước cho vòng hỏi (FLF-232). Transcript được lọc theo step nên sang giai đoạn mới AI mất
 * mạch (chào lại, hỏi lại điều vừa bàn). Hai biến prompt dựng ở đây — KHÔNG gọi model, hàm thuần:
 *
 *  - `recent_turns`: `RECENT_TURNS` tin gần nhất của cả transcript, mọi step;
 *  - `conversation_summary`: ≤ `SUMMARY_MAX_WORDS` từ gồm ý tưởng + mục tiêu, các điều đã chốt và vài lời user vừa nói.
 *
 * Không nạp toàn transcript (điều cấm #4): chỉ đuôi ngắn và một bản tóm tắt có trần.
 */

import type { Spine } from "../spine/spine.types.js"
import { briefCoreEntries } from "../spine/brief-core.js"
import { activeDecisions } from "./decisions.service.js"

/** Số tin gần nhất của cả transcript đưa vào `recent_turns`. */
export const RECENT_TURNS = 6
/** Trần độ dài bản tóm tắt (từ). */
export const SUMMARY_MAX_WORDS = 150
/** Trần độ dài từng tin trong `recent_turns` (ký tự). */
const TURN_MAX_CHARS = 500
/** Số lời user gần nhất đưa vào bản tóm tắt, mỗi lời cắt còn chừng này từ. */
const SUMMARY_USER_LINES = 3
const SUMMARY_USER_LINE_WORDS = 25
const SUMMARY_MAX_DECISIONS = 10

export interface TranscriptMessage {
  role: "user" | "ai"
  content: string
  step?: string
}

const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean)

const truncateWords = (text: string, max: number): string => {
  const words = wordsOf(text)
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`
}

const truncateChars = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`)

/**
 * Tin AI của lượt hỏi được lưu dạng JSON `{reply, questions}` (`askTranscript`); prompt chỉ cần chữ AI đã nói.
 * Không phải JSON của dạng đó (tin cũ, chữ thường) ⇒ giữ nguyên.
 */
export const messageText = (message: TranscriptMessage): string => {
  const content = message.content.trim()
  if (message.role !== "ai" || !content.startsWith("{")) return content
  try {
    const parsed = JSON.parse(content) as { reply?: unknown; questions?: unknown }
    if (typeof parsed.reply !== "string") return content
    const asked = Array.isArray(parsed.questions)
      ? parsed.questions.flatMap((q) => (typeof (q as { question?: unknown })?.question === "string" ? [(q as { question: string }).question] : []))
      : []
    return asked.length > 0 ? `${parsed.reply.trim()} [đã hỏi: ${asked.join(" | ")}]` : parsed.reply.trim()
  } catch {
    return content
  }
}

/** `recent_turns`: đuôi `RECENT_TURNS` tin của cả transcript, một tin một dòng. */
export const formatRecentTurns = (transcript: readonly TranscriptMessage[], limit: number = RECENT_TURNS): string =>
  transcript
    .slice(-limit)
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${truncateChars(messageText(m).replace(/\s+/g, " "), TURN_MAX_CHARS)}`)
    .join("\n")

/**
 * `conversation_summary`: ý tưởng + mục tiêu (`project.vision/goals`), điều đã chốt (`decisions`) và vài lời user gần nhất.
 * Rỗng hoàn toàn ⇒ "(chưa có gì)" để prompt không còn chỗ trống khó hiểu.
 */
export const buildConversationSummary = (
  spine: Pick<Spine, "project" | "decisions"> & Partial<Pick<Spine, "addendum">>,
  transcript: readonly TranscriptMessage[]
): string => {
  const parts: string[] = []
  // Brief giữ tầm nhìn/mục tiêu ở addendum lõi (ngôn ngữ user); `project.vision/goals` chỉ có sau S-1.1
  const core = briefCoreEntries({ addendum: spine.addendum ?? [] })
  const vision = (core.vision?.content ?? spine.project.vision ?? "").trim()
  if (vision) parts.push(`Ý tưởng: ${truncateWords(vision, 40)}`)
  const coreGoals = core.goals.map((g) => g.content.trim())
  const goals = (coreGoals.length > 0 ? coreGoals : (spine.project.goals ?? [])).map((g) => g.trim()).filter(Boolean)
  if (goals.length > 0) parts.push(`Mục tiêu: ${goals.map((g) => truncateWords(g, 12)).join("; ")}`)

  const decisions = [...activeDecisions(spine).values()].slice(-SUMMARY_MAX_DECISIONS)
  if (decisions.length > 0) parts.push(`Đã chốt: ${decisions.map((d) => `${d.topic_key} = ${truncateWords(d.answer, 8)}`).join("; ")}`)

  const said = transcript
    .slice(-RECENT_TURNS)
    .filter((m) => m.role === "user")
    .slice(-SUMMARY_USER_LINES)
    .map((m) => truncateWords(m.content, SUMMARY_USER_LINE_WORDS))
    .filter(Boolean)
  if (said.length > 0) parts.push(`User vừa nói: ${said.map((s) => `"${s}"`).join(" / ")}`)

  if (parts.length === 0) return "(chưa có gì)"

  // Trần từ tính trên cả bản: phần nào vượt thì cắt ở đó (ý tưởng và mục tiêu đứng đầu nên được giữ trước)
  const kept: string[] = []
  let budget = SUMMARY_MAX_WORDS
  for (const part of parts) {
    const words = wordsOf(part)
    if (words.length <= budget) {
      kept.push(part)
      budget -= words.length
      continue
    }
    if (budget > 0) kept.push(`${words.slice(0, budget).join(" ")}…`)
    break
  }
  return kept.join("\n")
}
