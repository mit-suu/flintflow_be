/**
 * fast-path.ts
 * ─────────────────────────────────────────────────────────────────
 * Fast path của Brief (FLF-234): lượt hỏi gộp đầu B-1 là lượt hỏi DUY NHẤT của giai đoạn; các bước B-1.x viết trước, điều
 * chưa biết thành giả định và được nói ở cổng cuối. Luật nằm ở server — prompt chỉ là lời nhắc, không phải chỗ tin cậy.
 */

import type { Spine } from "../spine/spine.types.js"
import { byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"
import { elicitProjection } from "./context-projection.js"
import { activeDecisions, normalizeTopicKey, type AskedQuestion, type FilteredQuestions } from "./decisions.service.js"
import { MAX_QUESTIONS_PER_TURN } from "./question-shape.js"
import { getStep, orderedSteps } from "./step-registry.js"

/** Giai đoạn đi theo fast path: bước bên trong không tự hỏi sau lượt hỏi gộp đầu giai đoạn. */
export const FAST_PATH_PHASES: ReadonlySet<string> = new Set(["B-1"])

/**
 * - `normal`: Elicit như mọi bước;
 * - `skip`: không gọi model Elicit (lượt hỏi gộp đã hỏi hết những gì đáng hỏi);
 * - `conflict_only`: gọi Elicit vì có tin user mới, nhưng chỉ giữ câu mâu thuẫn với điều đã chốt.
 */
export type ElicitPolicy = "normal" | "skip" | "conflict_only"

/** Chính sách Elicit của một bước. Lượt chờ câu trả lời cũ (`resumeAnswers`) được xử lý trước, không qua hàm này. */
export const elicitPolicyFor = ({ phase, hasUserMessage }: { phase: string; hasUserMessage: boolean }): ElicitPolicy => {
  if (!FAST_PATH_PHASES.has(phase)) return "normal"
  return hasUserMessage ? "conflict_only" : "skip"
}

/** Giữ câu có `conflict` không rỗng trên chủ đề ĐÃ có trong sổ quyết định; còn lại bỏ (kèm danh sách để log). */
export const keepConflictsOnly = (spine: Pick<Spine, "decisions">, questions: readonly AskedQuestion[]): FilteredQuestions => {
  const decided = activeDecisions(spine)
  const out: FilteredQuestions = { questions: [], dropped: [] }
  for (const question of questions) {
    const topic = normalizeTopicKey(question.topic_key, question.question)
    if (question.conflict && question.conflict.trim() !== "" && decided.has(topic)) out.questions.push({ ...question, topic_key: topic })
    else out.dropped.push({ topic_key: topic, question: question.question, answer: decided.get(topic)?.answer ?? "" })
  }
  return out
}

/** Số câu tối đa của lượt hỏi gộp: dự án nội bộ hỏi ít (giả định nhiều hơn), còn lại hỏi đủ trần. */
export const interviewBudget = (stakes: string | null | undefined): number => (stakes === "internal" ? 2 : MAX_QUESTIONS_PER_TURN)

/** Các bước của đơn vị fast path (giai đoạn không có vòng lặp) theo thứ tự chạy. */
const unitStepIds = (spine: Spine, unit: string): string[] =>
  orderedSteps(spine)
    .filter((s) => s.loop === null && s.phase === unit)
    .map((s) => s.id)

/** Projection hợp của mọi bước trong giai đoạn (+ gốc luôn đọc của vòng hỏi); khoá trùng lấy bản đầu. */
export const interviewProjection = (spine: Spine, unit: string): Record<string, unknown> => {
  const merged: Record<string, unknown> = {}
  for (const id of unitStepIds(spine, unit)) {
    for (const [key, value] of Object.entries(elicitProjection(spine, id))) if (!(key in merged)) merged[key] = value
  }
  return merged
}

/** Việc của từng bước trong giai đoạn, mỗi bước một dòng `<label_en>: <description>` — lấy từ registry, không gọi model. */
export const interviewGuidance = (spine: Spine, unit: string): string =>
  unitStepIds(spine, unit)
    .map((id) => {
      const step = getStep(id)
      return `${step.label_en}: ${step.description}`
    })
    .join("\n")

/** Lời nhận tin khi server bỏ hết câu hỏi của model: không đặt câu hỏi nào mà UI không có thẻ/ô để trả lời. */
export const NO_QUESTION_ACK_VI = "Cảm ơn bạn. Chỗ nào còn chưa rõ, tôi sẽ viết theo cách hiểu hợp lý nhất rồi nói lại để bạn xem một lượt ở cuối."
/** Bản tiếng Anh cho phiên trả lời tiếng Anh (FLF-260). */
export const NO_QUESTION_ACK_EN = "Thanks. Where something is still unclear, I'll go with the most sensible reading and walk you through it once at the end."

/** Lời nhận tin theo ngôn ngữ trả lời của phiên; mặc định tiếng Việt như trước FLF-260. */
export const noQuestionAck = (language: ReplyLanguage = "vi"): string => byLanguage(language, { vi: NO_QUESTION_ACK_VI, en: NO_QUESTION_ACK_EN })

const wordsOf = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  )

/** Độ trùng từ (không dấu) giữa hai câu: tỉ lệ từ chung trên số từ của câu ít từ hơn; 0..1. */
const overlap = (sentence: string, question: string): number => {
  const a = wordsOf(sentence)
  const b = wordsOf(question)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.min(a.size, b.size)
}

const best = (sentence: string, questions: readonly string[]): number => questions.reduce((max, q) => Math.max(max, overlap(sentence, q)), 0)

/**
 * Tách lời AI thành từng câu mà KHÔNG mất chữ nào: nối các mảnh lại ra đúng nguyên văn, giữ dòng trống giữa các đoạn và
 * dòng `- ` (cắt câu xong nối bằng dấu cách thì cả lời dính thành một khối). Cắt sau dấu kết câu có khoảng trắng theo sau
 * — "99.9%", "1.000", "v1.2" không bị cắt đôi — và ở mỗi lần xuống dòng (dòng `- ` không có dấu chấm vẫn là một mảnh).
 */
export const replyChunks = (text: string): string[] => text.split(/(?<=[.!?…][)"'”»*_]*\s+|\n\s*)(?=\S)/u)

/** Mảnh là một câu hỏi: kết bằng "?" (kể cả khi còn ngoặc, nháy hay `**` markdown phía sau). */
export const isQuestionChunk = (chunk: string): boolean => /[?？][)"'”»*_]*\s*$/u.test(chunk)

/**
 * Lời AI sau khi server bỏ bớt câu hỏi của model: `reply` không được nêu câu hỏi mà UI không hỏi.
 * - không bỏ câu nào ⇒ giữ nguyên;
 * - bỏ mà không còn câu nào được hỏi ⇒ cắt MỌI câu hỏi trong lời (không câu nào còn chỗ trả lời), giữ phần phản hồi user;
 * - còn câu được hỏi ⇒ cắt các câu kết thúc bằng "?" giống câu đã bị bỏ (≥ 60% từ, và giống hơn mọi câu còn được hỏi).
 * Cắt hết ⇒ lời nhận tin. Khớp theo từ nên là best effort — câu diễn đạt quá khác vẫn lọt; prompt đã dặn model đừng viết thế.
 * `language`: ngôn ngữ của lời nhận tin thay thế (FLF-260).
 */
export const reconcileReply = (
  reply: string,
  droppedQuestions: readonly string[],
  keptQuestions: readonly string[],
  language: ReplyLanguage = "vi"
): string => {
  if (droppedQuestions.length === 0) return reply
  const text = replyChunks(reply)
    .filter((chunk) => {
      if (!isQuestionChunk(chunk)) return true
      if (keptQuestions.length === 0) return false
      const dropped = best(chunk, droppedQuestions)
      return !(dropped >= 0.6 && dropped > best(chunk, keptQuestions))
    })
    .join("")
    .trim()
  return text === "" ? noQuestionAck(language) : text
}

/**
 * Câu hỏi đuôi trong lời AI ("bạn thấy hợp lý chứ?", "đúng không?") tính vào trần câu hỏi của lượt: đã hỏi đủ `budget` câu
 * trong `asked` mà lời AI còn kết bằng một câu hỏi KHÔNG phải câu nào đang hỏi (< 60% từ trùng) ⇒ cắt câu đó. Câu hỏi
 * `inline` chỉ tồn tại trong lời AI (UI không vẽ lại) nên không bao giờ cắt khi số câu hỏi trong lời ≤ số câu inline — model
 * viết lại câu inline khác chữ `question` thì vẫn giữ. Cắt hết ⇒ lời nhận tin cố định (theo `language`, FLF-260).
 */
export const trimTailQuestion = (
  reply: string,
  asked: readonly { question: string; inline?: boolean }[],
  budget: number,
  language: ReplyLanguage = "vi"
): string => {
  if (asked.length < budget) return reply
  const chunks = replyChunks(reply.trimEnd())
  const questionSentences = chunks.filter(isQuestionChunk).length
  const inlineCount = asked.filter((q) => q.inline).length
  if (questionSentences <= inlineCount) return reply
  const last = chunks[chunks.length - 1] ?? ""
  if (
    !isQuestionChunk(last) ||
    best(
      last,
      asked.map((q) => q.question)
    ) >= 0.6
  )
    return reply
  const text = chunks.slice(0, -1).join("").trim()
  return text === "" ? noQuestionAck(language) : text
}

/** Câu hỏi đi kèm lời AI — đủ để biết câu nào user thấy trên thẻ, câu nào chỉ nằm trong lời (`inline`). */
export interface ReplyQuestion {
  question: string
  inline?: boolean
  options: readonly unknown[]
}

/**
 * Câu `inline` (FE không vẽ thẻ) phải thật sự được hỏi trong lời AI: model hay gắn `inline: true` mà không viết câu đó vào
 * `reply`, hoặc server vừa cắt nó khỏi lời ⇒ câu đang chờ mà user không thấy và không biết trả lời gì. Khớp một câu hỏi trong
 * lời (≥ 60% từ) ⇒ giữ; không khớp thì vẫn giữ nếu lời còn một câu hỏi chưa ứng với câu nào (model diễn lại khác chữ), trừ
 * câu chép lại thẻ lựa chọn. Còn lại ⇒ bỏ `inline` để FE vẽ thành thẻ câu mở. Ngược lại, câu mở không gắn `inline` mà lời
 * đã hỏi nó ⇒ gắn `inline` (lịch sử chat không liệt kê lại; FE vẫn có ô nhập cho mọi câu trên thẻ hỏi).
 */
export const keepInlineVisible = <Q extends ReplyQuestion>(reply: string, asked: readonly Q[]): Q[] => {
  const isInline = (q: Q): boolean => q.inline === true && q.options.length === 0
  if (!asked.some((q) => q.options.length === 0)) return [...asked]
  const cards = asked.filter((q) => q.options.length > 0).map((q) => q.question)
  const free = replyChunks(reply)
    .filter(isQuestionChunk)
    .filter((chunk) => cards.length === 0 || best(chunk, cards) < 0.6)
  const visible = new Set<number>()
  asked.forEach((q, i) => {
    if (!isInline(q)) return
    const at = free.findIndex((chunk) => overlap(chunk, q.question) >= 0.6)
    if (at < 0) return
    visible.add(i)
    free.splice(at, 1)
  })
  // Câu mở model quên gắn `inline` mà lời đã hỏi nó (≥ 60% từ) ⇒ gắn, để lịch sử chat không liệt kê câu đó lần nữa
  const askedInReply = new Set<number>()
  asked.forEach((q, i) => {
    if (q.options.length > 0 || isInline(q)) return
    const at = free.findIndex((chunk) => overlap(chunk, q.question) >= 0.6)
    if (at < 0) return
    askedInReply.add(i)
    free.splice(at, 1)
  })
  return asked.map((q, i) => {
    if (askedInReply.has(i)) return { ...q, inline: true }
    if (!isInline(q) || visible.has(i)) return q
    if (free.length > 0) {
      free.shift()
      return q
    }
    const { inline: _inline, ...card } = q
    return card as Q
  })
}

/**
 * Lời AI và câu server thật sự hỏi phải khớp nhau — user chỉ trả lời được câu có thẻ hoặc câu `inline` nằm ngay trong lời.
 * Áp ở MỌI lượt hỏi (step, phỏng vấn đầu giai đoạn, lượt chat khi còn câu chờ), không riêng fast path:
 * - câu model hỏi mà server bỏ (`dropped`: đã chốt, trùng chủ đề, quá trần, chủ đề lạ) ⇒ cắt khỏi lời (`reconcileReply`);
 * - server không hỏi câu nào ⇒ lời không được còn câu hỏi: lượt chạy đi tiếp ngay, câu hỏi trong lời không có chỗ trả lời;
 * - câu hỏi đuôi quá trần ⇒ cắt (`trimTailQuestion`);
 * - câu `inline` mà lời (sau khi cắt) không còn hỏi ⇒ thành thẻ (`keepInlineVisible`).
 */
export const alignReply = <Q extends ReplyQuestion>(
  reply: string,
  asked: readonly Q[],
  options: { dropped?: readonly string[]; budget: number; language?: ReplyLanguage }
): { reply: string; asked: Q[] } => {
  const language = options.language ?? "vi"
  const reconciled = asked.length === 0 ? withoutQuestions(reply, language) : reconcileReply(reply, options.dropped ?? [], asked.map((q) => q.question), language)
  const text = trimTailQuestion(reconciled, asked, options.budget, language)
  return { reply: text, asked: keepInlineVisible(text, asked) }
}

/**
 * Lời AI của lượt đóng phỏng vấn fast path: chỉ ghi nhận, không hỏi tiếp — bỏ mọi câu hỏi (kể cả câu hỏi tu từ / hỏi xác nhận);
 * không còn gì thì dùng lời nhận tin cố định (theo `language`, FLF-260).
 */
export const withoutQuestions = (reply: string, language: ReplyLanguage = "vi"): string => {
  const text = replyChunks(reply)
    .filter((sentence) => !sentence.includes("?"))
    .join("")
    .trim()
  return text === "" ? noQuestionAck(language) : text
}
