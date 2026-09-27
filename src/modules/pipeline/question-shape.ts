/**
 * question-shape.ts
 * ─────────────────────────────────────────────────────────────────
 * Luật hình dạng câu hỏi gửi user (FLF-220) — theo mẫu AskUserQuestion. Prompt dặn model hỏi bằng văn
 * xuôi và chỉ đưa lựa chọn khi thật sự cần quyết, nhưng server không tin prompt: mọi lượt hỏi (step,
 * phỏng vấn đầu giai đoạn, chat Discovery) đi qua đây trước khi tới user.
 *
 * - tối đa `MAX_QUESTIONS_PER_TURN` câu/lượt;
 * - câu có lựa chọn giữ 2–4 option; còn 1 ⇒ thành câu mở (một lựa chọn duy nhất không phải là hỏi);
 * - bỏ option "Khác"/"Other" model tự viết — FE luôn tự thêm dòng "Khác…";
 * - `header` (nhãn tab) cắt ≤ 12 ký tự.
 */

import { chatQuestionItemSchema, type QuestionOption } from "../../shared/ai/response-parser.js"
import { RECOMMENDED_SUFFIX, sanitizeSuggestions, type AnsweredTopic } from "./decisions.service.js"

/** Trần câu hỏi một lượt, cho mọi nơi — kể cả phỏng vấn đầu giai đoạn. Câu còn thiếu để step sau tự hỏi. */
export const MAX_QUESTIONS_PER_TURN = 4
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4
export const MAX_HEADER_LENGTH = 12

/** Option model tự viết thay cho ô nhập tự do — trùng với dòng "Khác…" FE đã có. */
const MODEL_OTHER_OPTION = /^(khác|lựa chọn khác|ý kiến khác|phương án khác|tự nhập|nhập khác|other|something else)\s*(\.{3}|…|:|\(.*\))?\s*$/i

/** Bỏ đuôi "(Khuyến nghị)" — nhãn hiển thị của thẻ, không phải một phần câu trả lời. */
export const stripRecommended = (label: string): string => label.replace(RECOMMENDED_SUFFIX, "").trim()

/** Một câu trả lời user gửi qua `/answer` (hoặc ô chat). */
export interface QuestionAnswer {
  question_id: string
  answer: string | string[]
}

/** Câu hỏi sau khi parse (`elicitQuestionSchema` / `chatQuestionSchema`). */
export interface ModelQuestion {
  question: string
  header?: string
  options: QuestionOption[]
  multiple?: boolean
  topic_key?: string
}

/** Câu gửi user — đúng `questionSchema` của hợp đồng, luôn ở dạng option object. */
export interface ContractQuestion {
  id: string
  text: string
  header?: string
  options?: QuestionOption[]
  multiple?: boolean
}

/** Lọc và cắt lựa chọn theo luật server; trả `[]` khi không còn đủ 2 lựa chọn thật. */
export const shapeOptions = (options: readonly QuestionOption[], topicKey?: string): QuestionOption[] => {
  const seen = new Set<string>()
  const kept: QuestionOption[] = []
  for (const option of options) {
    const label = option.label.trim()
    const key = stripRecommended(label).toLowerCase()
    if (key === "" || MODEL_OTHER_OPTION.test(label) || seen.has(key)) continue
    seen.add(key)
    kept.push({ ...option, label })
  }
  // BUG-30: gợi ý tên hệ thống sai luật bị lọc ở server
  const sanitized = topicKey ? sanitizeSuggestions(topicKey, kept) : kept
  const capped = sanitized.slice(0, MAX_OPTIONS)
  return capped.length >= MIN_OPTIONS ? capped : []
}

const shapeHeader = (header: string | undefined): string | undefined => {
  const trimmed = header?.trim().slice(0, MAX_HEADER_LENGTH).trim()
  return trimmed ? trimmed : undefined
}

export interface ShapedQuestions<Q extends ModelQuestion> {
  /** Câu model hỏi còn lại (đã áp luật), cùng thứ tự với `questions` — `asked[i]` là `Q${i + 1}`. */
  asked: Q[]
  /** Câu gửi FE qua `answer_needed` / lưu run-state. */
  questions: ContractQuestion[]
}

export const shapeQuestions = <Q extends ModelQuestion>(input: readonly Q[]): ShapedQuestions<Q> => {
  const asked = input
    .filter((q) => q.question.trim() !== "")
    .slice(0, MAX_QUESTIONS_PER_TURN)
    .map((q) => {
      const options = shapeOptions(q.options, q.topic_key)
      const header = shapeHeader(q.header)
      return { ...q, options, header, multiple: options.length > 0 ? q.multiple : undefined }
    })
  const questions = asked.map((q, i): ContractQuestion => ({
    id: `Q${i + 1}`,
    text: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.options.length > 0 ? { options: q.options } : {}),
    ...(q.options.length > 0 && q.multiple !== undefined ? { multiple: q.multiple } : {})
  }))
  return { asked, questions }
}

/** Câu trả lời thành chữ: bỏ đuôi "(Khuyến nghị)" ở từng lựa chọn rồi nối. */
export const answerText = (answer: QuestionAnswer["answer"]): string =>
  (Array.isArray(answer) ? answer.map(stripRecommended).join(", ") : stripRecommended(answer)).trim()

/**
 * Câu trả lời nào đủ tin để ghi sổ quyết định. Câu có lựa chọn luôn ghi. Câu mở chỉ ghi khi mỗi câu mở
 * của lượt có câu trả lời riêng — user gõ một đoạn không đánh số thì FE gán cả đoạn cho câu đầu, và ghi
 * đoạn đó làm "đáp án" của một chủ đề sẽ khiến sổ nhiễu (cổng chốt báo mâu thuẫn sai). Đoạn đó vẫn tới
 * lượt Draft qua `answersText`.
 */
export const answeredTopics = (
  asked: readonly (ModelQuestion & { topic_key: string })[],
  answers: readonly QuestionAnswer[]
): AnsweredTopic[] => {
  const byIndex = new Map<number, string>()
  for (const a of answers) {
    const index = Number(/^Q(\d+)$/.exec(a.question_id)?.[1] ?? 0) - 1
    if (asked[index]) byIndex.set(index, answerText(a.answer))
  }
  const openIndexes = asked.flatMap((q, i) => (q.options.length === 0 ? [i] : []))
  const openSplit = openIndexes.every((i) => (byIndex.get(i) ?? "") !== "")
  return [...byIndex.entries()].flatMap(([index, answer]) => {
    const question = asked[index]
    if (question.options.length === 0 && !openSplit) return []
    return [{ topic_key: question.topic_key, question: question.question, answer }]
  })
}

/** Câu hỏi lưu trong tin nhắn chat Discovery — FE đọc `question`/`options` (tin nhắn cũ: `suggestedAnswers`). */
export interface ChatQuestion {
  question: string
  header?: string
  options?: QuestionOption[]
  multiple?: boolean
}

/**
 * Chat Discovery lưu nguyên JSON model vào tin nhắn nên phải áp cùng luật trước khi lưu. Chat không có
 * `topic_key` ⇒ không lọc theo sổ quyết định, chỉ áp luật hình dạng. Nhận cả dạng cũ (`suggestedAnswers`,
 * chuỗi trơn) vì nhánh cứu hộ của parser trả thẳng mảng model viết.
 */
export const shapeChatQuestions = (raw: unknown): ChatQuestion[] => {
  if (!Array.isArray(raw)) return []
  const parsed = raw.flatMap((item) => {
    const result = chatQuestionItemSchema.safeParse(item)
    return result.success ? [result.data] : []
  })
  return shapeQuestions(parsed).asked.map((q) => ({
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.options.length > 0 ? { options: q.options } : {}),
    ...(q.options.length > 0 && q.multiple !== undefined ? { multiple: q.multiple } : {})
  }))
}

/** Nhãn của một option trong hợp đồng — run-state cũ còn lưu chuỗi trơn. */
export const optionLabel = (option: string | { label: string }): string => (typeof option === "string" ? option : option.label)

/**
 * Tin nhắn chat gõ thẳng (có đính kèm nên không đi đường trả lời theo câu của FE) trong lúc step chờ trả lời:
 * gán cho câu mở đầu tiên. Gán vào câu có lựa chọn thì cả đoạn văn thành "đáp án" của chủ đề đó trong sổ
 * quyết định. Không có câu mở (hoặc run-state cũ không có câu hỏi) ⇒ `Q1` như trước.
 */
export const chatReplyQuestionId = (questions: readonly unknown[] | null | undefined): string => {
  for (const item of questions ?? []) {
    const q = item as { id?: unknown; options?: unknown }
    if (typeof q.id === "string" && (!Array.isArray(q.options) || q.options.length === 0)) return q.id
  }
  return "Q1"
}
