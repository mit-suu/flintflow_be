/**
 * decisions.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Sổ quyết định (`spine.decisions[]`) — `02-reduce-stops-plan.md` R4, FLF-208.
 *
 * Trong lượt test, uptime bị hỏi ở S-1.4, S-6.1 và S-7.2; "giữ chỗ 15 phút" bị hỏi ở S-4.4, S-5.2 và
 * S-5.4; rồi AI còn gợi ý "cọc 30%" trong khi user đã chốt 50.000₫ từ B-0.1. Nguyên nhân chung: câu trả
 * lời của user chỉ sống trong transcript của step đã hỏi, không step nào sau đó đọc được.
 *
 * Sổ này là bộ nhớ chung:
 *  - mỗi câu hỏi model sinh ra mang một `topic_key` (khoá chủ đề, không phải câu chữ);
 *  - **server** bỏ câu hỏi có `topic_key` đã chốt, trừ khi model tuyên bố `conflict` kèm lý do;
 *  - câu trả lời của user được ghi lại thành `decisions[]`, và mọi lượt elicit sau đều nhận sổ trong context.
 *
 * Quyết định cũ không bị xoá khi user đổi ý — dòng cũ mang `superseded_by` trỏ tới dòng mới, để §I Record
 * of Changes và người đọc sau còn thấy được đã từng chốt gì.
 */

import { allocateId } from "../spine/id-allocator.js"
import type { Decision, Spine } from "../spine/spine.types.js"
import type { Op } from "../spine/op.types.js"

/**
 * Khoá chủ đề chuẩn hoá. Model được dùng khoá tự do, nhưng mọi khoá quen thuộc phải rơi về đúng một tên —
 * `uptime` và `availability` mà thành hai khoá thì sổ mất tác dụng.
 */
export const CANONICAL_TOPIC_KEYS: readonly string[] = Object.freeze([
  "system_name",
  "uptime",
  "concurrent_users",
  "response_time",
  "data_retention",
  "slot_hold_minutes",
  "deposit_amount",
  "cancel_window",
  "no_show_policy",
  "reminder_channel",
  "notification_channels",
  "ui_languages",
  "roles",
  "working_hours",
  "payment_method",
  "screen_scope",
  "release_scope"
])

/** Từ đồng nghĩa hay gặp → khoá chuẩn. */
const TOPIC_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  availability: "uptime",
  sla: "uptime",
  uptime_target: "uptime",
  concurrency: "concurrent_users",
  peak_users: "concurrent_users",
  hold_time: "slot_hold_minutes",
  slot_hold: "slot_hold_minutes",
  deposit: "deposit_amount",
  cancellation_window: "cancel_window",
  cancel_policy: "cancel_window",
  noshow: "no_show_policy",
  no_show: "no_show_policy",
  reminder: "reminder_channel",
  reminders: "reminder_channel",
  languages: "ui_languages",
  language: "ui_languages",
  product_name: "system_name",
  name: "system_name"
})

const slug = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)

/** `topic_key` của model → khoá chuẩn; model bỏ trống thì suy từ chính câu hỏi (lưới an toàn của R4). */
export const normalizeTopicKey = (raw: string | undefined | null, question: string): string => {
  const base = slug(raw && raw.trim() !== "" ? raw : question)
  if (base === "") return "unknown"
  return TOPIC_ALIASES[base] ?? base
}

/** Quyết định còn hiệu lực theo `topic_key` (bỏ dòng đã bị thay thế). */
export const activeDecisions = (spine: Pick<Spine, "decisions">): Map<string, Decision> => {
  const byTopic = new Map<string, Decision>()
  for (const decision of spine.decisions ?? []) {
    if (decision.superseded_by !== null) continue
    byTopic.set(decision.topic_key, decision)
  }
  return byTopic
}

export interface AskedQuestion {
  question: string
  suggestedAnswers: string[]
  multiple?: boolean
  topic_key?: string
  /** Model khẳng định chủ đề này cần hỏi lại (dữ liệu mới mâu thuẫn) — kèm lý do trong `conflict`. */
  conflict?: string
}

export interface FilteredQuestions {
  /** Câu còn lại sau khi bỏ câu đã chốt, mỗi câu kèm `topic_key` đã chuẩn hoá. */
  questions: (AskedQuestion & { topic_key: string })[]
  /** Câu bị bỏ vì đã có trong sổ — runner ghi log và trả lời model bằng chính giá trị đã chốt. */
  dropped: { topic_key: string; question: string; answer: string }[]
}

/**
 * Bỏ câu hỏi thuộc chủ đề đã chốt. Đây là **luật của server**, không phải lời nhắc trong prompt: model
 * quên đọc sổ thì user vẫn không bị hỏi lại.
 */
export const filterAskedQuestions = (spine: Pick<Spine, "decisions">, questions: readonly AskedQuestion[]): FilteredQuestions => {
  const decided = activeDecisions(spine)
  const out: FilteredQuestions = { questions: [], dropped: [] }
  const seenInThisTurn = new Set<string>()

  for (const question of questions) {
    const topic = normalizeTopicKey(question.topic_key, question.question)
    const previous = decided.get(topic)
    if (previous && !question.conflict) {
      out.dropped.push({ topic_key: topic, question: question.question, answer: previous.answer })
      continue
    }
    // Hai câu cùng chủ đề trong một lượt cũng là hỏi lặp
    if (seenInThisTurn.has(topic)) {
      out.dropped.push({ topic_key: topic, question: question.question, answer: previous?.answer ?? "" })
      continue
    }
    seenInThisTurn.add(topic)
    out.questions.push({ ...question, topic_key: topic })
  }
  return out
}

export interface AnsweredTopic {
  topic_key: string
  question: string
  answer: string
}

/**
 * Op ghi câu trả lời vào sổ. Chủ đề đã có dòng còn hiệu lực ⇒ dòng cũ được đánh `superseded_by` thay vì
 * bị xoá. Trả `[]` khi không có gì để ghi.
 */
export const decisionOps = (spine: Spine, stepId: string, answered: readonly AnsweredTopic[], now: Date = new Date()): Op[] => {
  if (answered.length === 0) return []
  const ops: Op[] = []
  const working: Spine = { ...spine, decisions: [...(spine.decisions ?? [])] }
  const at = now.toISOString()

  for (const item of answered) {
    if (item.answer.trim() === "") continue
    const id = allocateId(working, "decisions") ?? `DC${working.decisions.length + 1}`
    const previous = activeDecisions(working).get(item.topic_key)
    if (previous) {
      if (previous.answer.trim() === item.answer.trim()) continue
      ops.push({ op: "set", path: `decisions[id=${previous.id}].superseded_by`, value: id })
      working.decisions = working.decisions.map((d) => (d.id === previous.id ? { ...d, superseded_by: id } : d))
    }
    const decision: Decision = {
      id,
      topic_key: item.topic_key,
      question: item.question,
      answer: item.answer.trim(),
      step_id: stepId,
      at,
      superseded_by: null
    }
    ops.push({ op: "add", path: "decisions[]", value: decision, reason: `Chốt ${item.topic_key} ở ${stepId}` })
    working.decisions = [...working.decisions, decision]
  }
  return ops
}

/** Đuôi rỗng nghĩa trong tên hệ thống — "Minh An Clinic Appointment System" chỉ dài thêm, không rõ thêm. */
const FILLER_NAME_SUFFIX = /\s+(system|app|application|platform|software|solution|tool|portal)$/i

/**
 * BUG-30: gợi ý tên hệ thống phải theo đúng luật mà skill đã nêu (2–4 từ, không đuôi System/App). Model
 * vi phạm thì server lọc, thay vì để user chọn nhầm rồi tên sai đi vào bìa tài liệu và mọi sơ đồ.
 * Lọc hết thì trả lại nguyên bản — thà có gợi ý chưa chuẩn còn hơn một câu hỏi trống trơn.
 */
export const sanitizeSuggestions = (topicKey: string, options: readonly string[]): string[] => {
  if (topicKey !== "system_name") return [...options]
  const kept = options.filter((option) => !FILLER_NAME_SUFFIX.test(option.trim()))
  return kept.length > 0 ? kept : [...options]
}

/** Sổ đưa vào prompt: gọn, chỉ điều còn hiệu lực — "đã chốt gì, ở bước nào". */
export const ledgerForPrompt = (spine: Pick<Spine, "decisions">): { topic_key: string; answer: string; step_id: string }[] =>
  [...activeDecisions(spine).values()].map(({ topic_key, answer, step_id }) => ({ topic_key, answer, step_id }))
