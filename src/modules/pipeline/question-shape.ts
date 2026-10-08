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
/**
 * Số câu hỏi tối đa mỗi lượt mà PROMPT được phép hỏi (FLF-232): BA thật không tra hỏi 3–4 câu một lượt. Trần `MAX_QUESTIONS_PER_TURN`
 * ở trên vẫn là lưới an toàn của server cho model không nghe lời.
 */
export const PROMPT_QUESTIONS_PER_TURN = 2
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4
export const MAX_HEADER_LENGTH = 12

/**
 * Option model tự viết thay cho ô nhập tự do — trùng với dòng "Khác…" FE đã có. Có cả cách viết của lượt trả lời tiếng Anh
 * (FLF-260). "Custom" chỉ tính khi có dấu mời nhập ("Custom…", "Custom:"): "Custom" trơn là một phương án thật (giao diện
 * mặc định / tuỳ biến).
 */
const MODEL_OTHER_OPTION =
  /^(?:(khác|lựa chọn khác|ý kiến khác|phương án khác|tự nhập|nhập khác|other|others|other options?|another option|something else)\s*(\.{3}|…|:|\(.*\))?|custom\s*(\.{3}|…|:))\s*$/i

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
  /** FLF-232: câu mở đã hỏi ngay trong lời `reply` ⇒ FE không hiện thêm thẻ. Chỉ có nghĩa với câu không có lựa chọn. */
  inline?: boolean
  /** Nội bộ: số tin chat user đã gửi trong lúc câu này chờ mà AI chưa chốt được (không gửi FE — xem `settleRepeatedAnswer`). */
  replied?: number
}

/** Câu gửi user — đúng `questionSchema` của hợp đồng, luôn ở dạng option object. */
export interface ContractQuestion {
  id: string
  text: string
  header?: string
  options?: QuestionOption[]
  multiple?: boolean
  inline?: boolean
}

/** Lọc và cắt lựa chọn theo luật server; trả `[]` khi không còn đủ 2 lựa chọn thật. */
export const shapeOptions = (options: readonly QuestionOption[], topicKey?: string): QuestionOption[] => {
  const seen = new Set<string>()
  const kept: QuestionOption[] = []
  for (const option of options) {
    const label = option.label.trim()
    const key = stripRecommended(label).toLowerCase()
    // Phương án được khuyến nghị không bao giờ là ô nhập tự do — đuôi "(Recommended)" không được lọt vào nhánh "(…)"
    if (key === "" || (!RECOMMENDED_SUFFIX.test(label) && MODEL_OTHER_OPTION.test(label)) || seen.has(key)) continue
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

/**
 * Id câu hỏi ổn định theo `topic_key` (FLF-221): `Q_<topic_key>`. Id theo vị trí (`Q1`, `Q2`) lệch ngay khi một câu
 * được chốt qua chat và danh sách câu còn chờ ngắn lại. Câu không có `topic_key` (chat Discovery) giữ `Q<n>`; hai câu
 * trùng chủ đề trong một lượt ⇒ câu sau thêm hậu tố.
 */
export const questionIdsFor = (asked: readonly Pick<ModelQuestion, "topic_key">[]): string[] => {
  const used = new Set<string>()
  return asked.map((q, i) => {
    let id = q.topic_key ? `Q_${q.topic_key}` : `Q${i + 1}`
    for (let n = 2; used.has(id); n++) id = `${q.topic_key ? `Q_${q.topic_key}` : `Q${i + 1}`}_${n}`
    used.add(id)
    return id
  })
}

/** Vị trí của `questionId` trong `asked`: id theo chủ đề, hoặc `Q<n>` theo vị trí (run-state lưu trước FLF-221). -1 ⇒ không có. */
export const indexOfQuestion = (asked: readonly Pick<ModelQuestion, "topic_key">[], questionId: string): number => {
  const byTopic = questionIdsFor(asked).indexOf(questionId)
  if (byTopic >= 0) return byTopic
  const positional = /^Q(\d+)$/.exec(questionId)
  const index = positional ? Number(positional[1]) - 1 : -1
  return index >= 0 && index < asked.length ? index : -1
}

export interface ShapedQuestions<Q extends ModelQuestion> {
  /** Câu model hỏi còn lại (đã áp luật), cùng thứ tự với `questions` — id của `asked[i]` là `questionIdsFor(asked)[i]`. */
  asked: Q[]
  /** Câu gửi FE qua `answer_needed` / lưu run-state. */
  questions: ContractQuestion[]
}

export interface ShapeOptions {
  /**
   * User chưa có ý tưởng (FLF-221, `hasIdea` false): chưa có gì làm căn cứ để khuyến nghị ⇒ bỏ đuôi "(Khuyến nghị)"
   * ở mọi option, giữ nguyên thứ tự model đưa (không đẩy option nào lên đầu).
   */
  noIdeaYet?: boolean
  /** Chỉ hỏi bằng văn xuôi: bỏ hết option — câu gợi mở cho user chưa có ý tưởng không phải là câu chọn. */
  proseOnly?: boolean
}

export const shapeQuestions = <Q extends ModelQuestion>(input: readonly Q[], shape: ShapeOptions = {}): ShapedQuestions<Q> => {
  const real = input.filter((q) => q.question.trim() !== "")
  // Cắt im lặng thì câu thừa rơi mất cùng `topic_key` của nó và không ai biết model đang phát quá trần —
  // chủ đề đó không vào sổ quyết định nên cũng không step nào hỏi lại.
  if (real.length > MAX_QUESTIONS_PER_TURN) {
    const dropped = real.slice(MAX_QUESTIONS_PER_TURN)
    console.info(
      `[question-shape] bỏ ${dropped.length} câu quá trần ${MAX_QUESTIONS_PER_TURN} (${dropped.map((q) => q.topic_key ?? "(không có chủ đề)").join(", ")})`
    )
  }
  const asked = real
    .slice(0, MAX_QUESTIONS_PER_TURN)
    .map((q) => {
      const shaped = shape.proseOnly ? [] : shapeOptions(q.options, q.topic_key)
      const options = shape.noIdeaYet ? shaped.map((o) => ({ ...o, label: stripRecommended(o.label) })) : shaped
      const header = shapeHeader(q.header)
      return { ...q, options, header, multiple: options.length > 0 ? q.multiple : undefined }
    })
  const ids = questionIdsFor(asked)
  const questions = asked.map((q, i): ContractQuestion => ({
    id: ids[i],
    text: q.question,
    ...(q.header ? { header: q.header } : {}),
    ...(q.options.length > 0 ? { options: q.options } : {}),
    ...(q.options.length > 0 && q.multiple !== undefined ? { multiple: q.multiple } : {}),
    ...(q.options.length === 0 && q.inline ? { inline: true } : {})
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
  answers: readonly QuestionAnswer[],
  /**
   * Câu đã được chốt riêng từng câu (qua chat tự do, server đã kiểm — FLF-221): ghi sổ kể cả khi câu mở khác của lượt
   * chưa có câu trả lời. Luật "đủ mọi câu mở" chỉ dành cho đoạn chat gõ gộp mà FE gán cả vào một câu.
   */
  settledIds: ReadonlySet<string> = new Set()
): AnsweredTopic[] => {
  const byIndex = new Map<number, string>()
  const settled = new Set<number>()
  for (const a of answers) {
    const index = indexOfQuestion(asked, a.question_id)
    if (index < 0) continue
    byIndex.set(index, answerText(a.answer))
    if (settledIds.has(a.question_id)) settled.add(index)
  }
  const openIndexes = asked.flatMap((q, i) => (q.options.length === 0 ? [i] : []))
  const openSplit = openIndexes.every((i) => (byIndex.get(i) ?? "") !== "")
  return [...byIndex.entries()].flatMap(([index, answer]) => {
    const question = asked[index]
    if (question.options.length === 0 && !openSplit && !settled.has(index)) return []
    return [{ topic_key: question.topic_key, question: question.question, answer }]
  })
}

/**
 * Tách tin nhắn user trả lời theo số (`1. …` / `1) …` đầu dòng) — cùng cách đánh số câu mở trong tin nhắn AI. Khoá là
 * vị trí 0-based theo số user gõ; dòng không đánh số nối vào đoạn đang mở, chữ trước số đầu tiên bị bỏ.
 */
export const splitNumberedAnswer = (message: string): Map<number, string> => {
  const out = new Map<number, string>()
  let current = -1
  for (const line of message.split("\n")) {
    const match = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (match) {
      current = Number(match[1]) - 1
      out.set(current, match[2].trim())
    } else if (current >= 0 && line.trim() !== "") {
      out.set(current, `${out.get(current) ?? ""} ${line.trim()}`.trim())
    }
  }
  for (const [index, text] of out) if (text === "") out.delete(index)
  return out
}

const normalizeText = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase()

/**
 * Trích đoạn model báo là câu trả lời của một câu: chỉ nhận khi nó là chuỗi con của tin nhắn user (bỏ khác biệt khoảng
 * trắng, hoa/thường) — model không được diễn lại hay bịa câu trả lời. Không phải chuỗi con ⇒ `undefined`.
 */
export const verifiedExcerpt = (excerpt: string, message: string): string | undefined => {
  const text = excerpt.trim()
  if (text === "") return undefined
  return normalizeText(message).includes(normalizeText(text)) ? text : undefined
}

/** Hai đoạn chữ giống nhau khi bỏ khác biệt khoảng trắng, hoa/thường. */
export const sameText = (a: string, b: string): boolean => normalizeText(a) === normalizeText(b)

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
