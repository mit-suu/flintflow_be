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
import { sentencesOf } from "./text-overlap.js"

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
 * Lời AI sau khi server bỏ bớt câu hỏi của model (fast path): `reply` không được nêu câu hỏi mà UI không hỏi.
 * - không bỏ câu nào ⇒ giữ nguyên;
 * - bỏ mà không còn câu nào được hỏi ⇒ thay bằng lời nhận tin không có câu hỏi;
 * - còn câu được hỏi ⇒ cắt các câu kết thúc bằng "?" giống câu đã bị bỏ (≥ 60% từ, và giống hơn mọi câu còn được hỏi); phần
 *   còn lại giữ, cắt hết thì thay lời nhận tin.
 * Khớp theo từ nên là best effort — câu diễn đạt quá khác vẫn lọt; prompt đã dặn model đừng viết thế.
 * `language`: ngôn ngữ của lời nhận tin thay thế (FLF-260).
 */
export const reconcileReply = (
  reply: string,
  droppedQuestions: readonly string[],
  keptQuestions: readonly string[],
  language: ReplyLanguage = "vi"
): string => {
  if (droppedQuestions.length === 0) return reply
  if (keptQuestions.length === 0) return noQuestionAck(language)
  const sentences = reply.match(/[^.!?…]+[.!?…]*s*/g) ?? [reply]
  const text = sentences
    .filter((sentence) => {
      if (!sentence.trim().endsWith("?")) return true
      const dropped = best(sentence, droppedQuestions)
      return !(dropped >= 0.6 && dropped > best(sentence, keptQuestions))
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
  const sentences = sentencesOf(reply)
  const questionSentences = sentences.filter((s) => s.trim().endsWith("?")).length
  const inlineCount = asked.filter((q) => q.inline).length
  if (questionSentences <= inlineCount) return reply
  const last = sentences[sentences.length - 1] ?? ""
  if (
    !last.trim().endsWith("?") ||
    best(
      last,
      asked.map((q) => q.question)
    ) >= 0.6
  )
    return reply
  const text = sentences.slice(0, -1).join(" ").trim()
  return text === "" ? noQuestionAck(language) : text
}

/**
 * Lời AI của lượt đóng phỏng vấn fast path: chỉ ghi nhận, không hỏi tiếp — bỏ mọi câu hỏi (kể cả câu hỏi tu từ / hỏi xác nhận);
 * không còn gì thì dùng lời nhận tin cố định (theo `language`, FLF-260).
 */
export const withoutQuestions = (reply: string, language: ReplyLanguage = "vi"): string => {
  const sentences = reply.match(/[^.!?…]+[.!?…]*s*/g) ?? [reply]
  const text = sentences
    .filter((sentence) => !sentence.includes("?"))
    .join("")
    .trim()
  return text === "" ? noQuestionAck(language) : text
}
