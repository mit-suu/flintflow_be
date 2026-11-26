/**
 * answered-questions.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-472: user trả lời câu hỏi mở ở cổng (S-1.3, S-1.4, B-1.6…) ⇒ lượt `revision` đóng câu hỏi (`remove
 * other_requirements[id=…]`). Trước đây câu trả lời chỉ còn trong `reason` của nhật ký thay đổi: không vào sổ quyết định,
 * không bước nào sau đọc được ⇒ bị hỏi lại. Nay model trả kèm `answered_questions` (cạnh `ops`), server:
 *  - đổi mỗi mục thành op `add decisions[]` (cùng lô với op đóng câu hỏi) — `answeredQuestionOps`;
 *  - TỪ CHỐI lô đóng một câu hỏi mở mà không kèm câu trả lời — `answeredQuestionErrors` (không đóng câu hỏi khi chưa lưu được
 *    câu trả lời).
 */

import type { AnsweredQuestion } from "../../shared/ai/response-parser.js"
import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { decisionOps, normalizeTopicKey, type AnsweredTopic } from "./decisions.service.js"
import type { ValidationError } from "./op-validator.js"

const QUESTION_PATH = /^other_requirements\[id=([^\]]+)\]$/

const slug = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "")

/** Mã câu hỏi mở bị `remove` trong lô (chỉ tính phần tử `kind: open_question` đang có trong Spine). */
const removedOpenQuestionIds = (spine: Spine, ops: readonly Op[]): string[] => {
  const open = new Set(spine.other_requirements.filter((r) => r.kind === "open_question").map((r) => r.id))
  const ids: string[] = []
  for (const op of ops) {
    if (op.op !== "remove") continue
    const id = QUESTION_PATH.exec(op.path)?.[1]
    if (id && open.has(id)) ids.push(id)
  }
  return ids
}

/**
 * Lô revision đóng câu hỏi mở thì mỗi câu phải có `answered_questions` (có `answer` không rỗng); mã trong
 * `answered_questions` phải là câu hỏi mở có thật; câu hỏi tự do (`id: null`) phải có `question`.
 */
export const answeredQuestionErrors = (spine: Spine, ops: readonly Op[], answered: readonly AnsweredQuestion[] | undefined, callKind: string): ValidationError[] => {
  const errors: ValidationError[] = []
  const list = answered ?? []
  const open = new Map(spine.other_requirements.filter((r) => r.kind === "open_question").map((r) => [r.id, r]))
  for (const item of list) {
    if (item.answer.trim() === "") {
      errors.push({ rule: "answered_question_empty", message: `answered_questions${item.id ? ` (${item.id})` : ""}: "answer" trống - đưa lời user trả lời (trích nguyên văn).` })
    } else if (item.id === null && !item.question?.trim()) {
      errors.push({ rule: "answered_question_unknown", message: 'answered_questions: mục "id": null phải có "question" (câu hỏi tự do ở lời cổng) và nên có "topic_key" chuẩn (vd "roles").' })
    } else if (item.id !== null && !open.has(item.id)) {
      errors.push({ rule: "answered_question_unknown", message: `answered_questions: ${item.id} không phải câu hỏi mở đang có - chỉ dùng mã trong other_requirements[kind=open_question].` })
    }
  }
  if (callKind !== "revision") return errors
  const answeredIds = new Set(list.filter((a) => a.id !== null && a.answer.trim() !== "").map((a) => a.id))
  for (const id of removedOpenQuestionIds(spine, ops)) {
    if (answeredIds.has(id)) continue
    errors.push({
      rule: "open_question_closed_without_answer",
      path: `other_requirements[id=${id}]`,
      message: `Không được xoá câu hỏi mở ${id} khi chưa lưu câu trả lời: thêm vào "answered_questions" mục { "id": "${id}", "answer": "<lời user, trích nguyên văn>" } (câu user bảo bỏ qua thì answer là chính lời đó).`
    })
  }
  return errors
}

/** Khoá chủ đề của câu hỏi mở đã trả lời: `open_question:<slug câu hỏi tiếng Anh>`. Câu tự do có `topic_key` thì dùng khoá đó. */
export const openQuestionTopicKey = (statement: string): string => `open_question:${slug(statement) || "unknown"}`

/**
 * Op ghi các câu trả lời vào sổ quyết định (`decisions[]`). Gọi SAU khi lô đã qua kiểm — op này do server sinh, không
 * phải op của model nên không qua `writable`. Chủ đề trùng khoá trong cùng lô được thêm đuôi mã câu hỏi để không đè nhau.
 */
export const answeredQuestionOps = (spine: Spine, stepId: string, answered: readonly AnsweredQuestion[] | undefined, now: Date = new Date()): Op[] => {
  if (!answered || answered.length === 0) return []
  const used = new Set<string>()
  const topics: AnsweredTopic[] = []
  for (const item of answered) {
    const answer = item.answer.trim()
    if (answer === "") continue
    const requirement = item.id ? spine.other_requirements.find((r) => r.id === item.id) : undefined
    const question = (requirement?.statement_vi || requirement?.statement || item.question || "").trim()
    if (question === "") continue
    let topic = item.id === null && item.topic_key?.trim() ? normalizeTopicKey(item.topic_key, question) : openQuestionTopicKey(requirement?.statement ?? question)
    if (used.has(topic)) topic = `${topic}_${(item.id ?? "free").toLowerCase()}`
    used.add(topic)
    topics.push({ topic_key: topic, question, answer })
  }
  return decisionOps(spine, stepId, topics, now)
}

/** Op `add` một câu hỏi mở mang mã tường minh (không phải mã tạm `$…`). */
const explicitQuestionId = (op: Op): string | null => {
  if (op.op !== "add" || op.path !== "other_requirements[]") return null
  const id = (op.value as { id?: unknown } | null | undefined)?.id
  return typeof id === "string" && id !== "" && !id.startsWith("$") ? id : null
}

/** Lô có op thêm `other_requirements[]` mang mã tường minh ⇒ mới cần tải tập mã đã xoá. */
export const addsExplicitQuestionId = (ops: readonly Op[]): boolean => ops.some((op) => explicitQuestionId(op) !== null)

/**
 * FLF-472 (#8): câu hỏi mở mới không được dùng lại mã đã xoá (của lượt trước hoặc của chính lô này) — "đã đóng OR10" ở
 * lượt sau sẽ trỏ nhầm câu khác. Mã tường minh trùng mã đã xoá ⇒ đổi thành mã tạm để op engine cấp mã kế tiếp (né cả mã đã
 * xoá, FLF-474); op sau trong lô nhắm mã cũ đó được đổi theo.
 */
export const renewReusedQuestionIds = (ops: readonly Op[], retired: readonly string[]): Op[] => {
  const gone = new Set(retired)
  const renamed = new Map<string, string>()
  return ops.map((op) => {
    let current: Op = op
    for (const [from, to] of renamed) {
      if (current.path.includes(`other_requirements[id=${from}]`)) current = { ...current, path: current.path.replace(`other_requirements[id=${from}]`, `other_requirements[id=${to}]`) }
    }
    const added = explicitQuestionId(current)
    if (added && gone.has(added)) {
      const placeholder = `$new_${added}`
      renamed.set(added, placeholder)
      return { ...current, value: { ...(current.value as Record<string, unknown>), id: placeholder } }
    }
    if (current.op === "remove") {
      const id = QUESTION_PATH.exec(current.path)?.[1]
      if (id) gone.add(id)
    }
    return current
  })
}
