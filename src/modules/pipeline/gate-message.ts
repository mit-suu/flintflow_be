/**
 * gate-message.ts
 * ─────────────────────────────────────────────────────────────────
 * Tin nhắn của cổng duyệt (FLF-232): cổng là một tin AI viết bằng lời thường + quick reply, không còn khung liệt kê.
 * Nội dung đến từ `notes` của lượt Draft (skill `draft-to-ops` viết 2–4 câu). Không có `notes` — project cũ, step tất định,
 * hoặc model bỏ trống — thì dựng tất định từ `summary[]` và giả định mới. Cổng cuối giai đoạn ghép tin của bước cuối với
 * những điều còn đang tạm hiểu của cả giai đoạn. Không bước nào ở đây gọi model.
 */

import type { ChangeSummary } from "./pipeline.dto.js"
import { contentWords, normalise, sentencesOf, wordsOf } from "./text-overlap.js"

export const FALLBACK_INVITE = "Bạn xem giúp, ổn thì mình đi tiếp nhé."
const ASSUMPTION_INVITE = "Nếu chỗ nào khác thì bạn nói tôi nhé."

/** Tối đa số nhóm nội dung được kể trong câu "Tôi đã cập nhật …". */
const MAX_SPOKEN_GROUPS = 4

/** Không kể ra: giả định và sổ quyết định là bộ máy bên trong, giả định được nói ở câu riêng. */
const HIDDEN_COLLECTIONS: ReadonlySet<string> = new Set(["assumptions", "decisions"])

/** Nhãn nói với user — khác nhãn tóm tắt của gate ở chỗ không lộ chữ nội bộ ("ghi chú Brief"). */
const SPOKEN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  project: "thông tin chung của hệ thống",
  addendum: "ghi chú",
  features: "nhóm chức năng",
  actors: "actor",
  roles: "vai trò",
  use_cases: "use case",
  screens: "màn hình",
  permissions: "quyền",
  entities: "thực thể dữ liệu",
  functions: "chức năng",
  validations: "ràng buộc",
  nfrs: "yêu cầu phi chức năng",
  business_rules: "quy tắc nghiệp vụ",
  common_requirements: "yêu cầu chung",
  messages: "thông điệp",
  other_requirements: "yêu cầu khác",
  glossary: "thuật ngữ",
  diagrams: "sơ đồ",
  custom_sections: "mục tự thêm"
})

const trimmed = (text: string | null | undefined): string => (text ?? "").trim()

/** "a" · "a và b" · "a, b và c". */
const joinList = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} và ${items[items.length - 1]}`

const stripEndPunctuation = (text: string): string => text.replace(/[\s.!?;,]+$/u, "")

/** Hạ chữ hoa đầu câu khi nối sau "tạm hiểu là": "Nhân viên …" ⇒ "nhân viên …"; giữ nguyên từ viết tắt ("SMS", "HIS"). */
const lowerFirst = (text: string): string => (/^\p{Lu}\p{Ll}/u.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text)

/** Câu tạm hiểu, chưa có lời mời cuối. */
const assumptionSentences = (texts: readonly string[]): string[] =>
  texts
    .map((t) => stripEndPunctuation(trimmed(t)))
    .filter((t) => t !== "")
    .map((text, i) => `Tôi ${i === 0 ? "" : "cũng "}tạm hiểu là ${lowerFirst(text)}.`)

/**
 * Câu nói những điều AI đang tạm hiểu, không dùng chữ "giả định". MỌI điều đều được nói (chip "Đúng rồi" xác nhận đúng những
 * điều này), mỗi điều một câu ngắn: "Tôi tạm hiểu là A. Tôi cũng tạm hiểu là B. Nếu chỗ nào khác thì bạn nói tôi nhé." Rỗng ⇒ null.
 */
export const assumptionSentence = (texts: readonly string[]): string | null => {
  const sentences = assumptionSentences(texts)
  return sentences.length === 0 ? null : [...sentences, ASSUMPTION_INVITE].join(" ")
}

const MATCH_RATIO = 0.6
const MIN_CONTENT_WORDS = 3

/**
 * Câu nói ra điều mình đang đoán (không phải kể như sự thật): "tôi tạm hiểu", "tôi đoán", "nếu khác bạn cứ nói"… Cụm bắt
 * đầu bằng "tôi" phải giữ dấu ("tới đoạn", "tới lấy" bỏ dấu thành "toi doan", "toi lay" — không phải lời đoán); cụm không
 * nhầm được thì so trên chữ bỏ dấu để model gõ không dấu vẫn khớp. Đều có ranh giới từ.
 */
const HEDGE_ACCENTED = /(^|[^\p{L}])tôi (đoán|nghĩ|giả sử|đề xuất|cho rằng|tạm hiểu)(?!\p{L})/u
const HEDGE_PLAIN = /(^|[^a-z0-9])(tam hieu|neu khac|co le|chac la)([^a-z0-9]|$)/
/** Chỉ dùng khi cả câu gõ không dấu (không thể so có dấu): "toi doan" lúc đó không thể là "tới đoạn". */
const HEDGE_UNACCENTED_TEXT = /(^|[^a-z0-9])toi (doan|nghi|gia su|de xuat|cho rang)([^a-z0-9]|$)/
const hasDiacritics = (text: string): boolean => /[\p{M}đĐ]/u.test(text.normalize("NFD"))
const isHedged = (sentence: string): boolean =>
  HEDGE_ACCENTED.test(sentence.toLowerCase()) ||
  HEDGE_PLAIN.test(normalise(sentence)) ||
  (!hasDiacritics(sentence) && HEDGE_UNACCENTED_TEXT.test(normalise(sentence)))

/**
 * Lời `notes` của model đã nói điều tạm hiểu này NHƯ MỘT ĐIỀU ĐANG ĐOÁN chưa: có một câu vừa mang dấu hiệu đoán (`HEDGE`)
 * vừa chứa phần lớn TỪ NỘI DUNG của điều đó (so trong phạm vi câu, không phải cả đoạn). Câu tóm tắt kể điều đó như sự thật
 * ("bệnh nhân đặt lịch trên app, còn nhân viên làm trên web") KHÔNG tính — user không biết đó là điều cần xác nhận.
 * Nghi ngờ thì coi là CHƯA nói — nói thừa còn hơn để chip xác nhận điều user chưa thấy.
 */
const isSpokenIn = (message: string, text: string): boolean => {
  const content = [...contentWords(text)]
  if (wordsOf(text).length === 0 || content.length === 0) return true
  if (content.length < MIN_CONTENT_WORDS) return normalise(message).includes(normalise(text).trim())
  return sentencesOf(message).some((sentence) => {
    if (!isHedged(sentence)) return false
    if (normalise(sentence).includes(normalise(text).trim())) return true
    const spoken = contentWords(sentence)
    const hits = content.filter((w) => spoken.has(w)).length
    return hits / content.length >= MATCH_RATIO
  })
}

const ensureSentenceEnd = (text: string): string => (/[.!?…]$/u.test(text) ? text : `${text}.`)

/** Câu cuối là lời mời đi tiếp / sửa ("… mình đi tiếp nhé", "nếu khác bạn cứ nói") — câu tạm hiểu phải chèn TRƯỚC nó. */
const CLOSING_INVITE = /di tiep|tiep nhe|tiep nha|cu noi|noi toi|noi minh|neu (cho nao )?khac|xem giup|sang phan/

/** Chèn các câu tạm hiểu trước lời mời cuối của `message`; không có lời mời cuối thì nối sau và tự thêm lời mời. */
const insertAssumptions = (message: string, texts: readonly string[]): string => {
  const sentences = assumptionSentences(texts)
  if (sentences.length === 0) return message
  const parts = sentencesOf(message)
  const last = parts[parts.length - 1] ?? ""
  if (parts.length > 1 && CLOSING_INVITE.test(normalise(last))) return [...parts.slice(0, -1), ...sentences, last].join(" ")
  return [ensureSentenceEnd(message), ...sentences, ASSUMPTION_INVITE].join(" ")
}

/** "Tôi đã cập nhật 3 use case và 2 yêu cầu phi chức năng." từ `summary[]`; không có gì đáng kể ⇒ null. */
const summarySentence = (summary: readonly ChangeSummary[]): string | null => {
  const groups = new Map<string, { added: number; changed: number }>()
  for (const row of summary) {
    if (HIDDEN_COLLECTIONS.has(row.collection)) continue
    const group = groups.get(row.collection) ?? { added: 0, changed: 0 }
    if (row.kind === "add") group.added += 1
    else group.changed += 1
    groups.set(row.collection, group)
  }
  const parts = [...groups.entries()].slice(0, MAX_SPOKEN_GROUPS).map(([collection, { added, changed }]) => {
    const label = SPOKEN_LABELS[collection] ?? collection
    return added > 0 && changed === 0 ? `${added} ${label} mới` : added + changed > 1 ? `${added + changed} ${label}` : label
  })
  if (parts.length === 0) return null
  const rest = groups.size - parts.length
  return `Tôi đã cập nhật ${joinList(parts)}${rest > 0 ? ` và ${rest} phần khác` : ""}.`
}

export interface StepGateMessageInput {
  /** `notes` của lượt Draft cuối (tin nhắn cổng do model viết). */
  notes?: string | null
  summary: readonly ChangeSummary[]
  /** Câu giả định mới của bước (ngôn ngữ user) — chỉ dùng khi phải dựng tin thay cho `notes`. */
  newAssumptionTexts?: readonly string[]
}

/**
 * Tin nhắn cổng của một bước. Có `notes` ⇒ dùng nguyên văn; không ⇒ dựng từ tóm tắt và điều tạm hiểu. Không có gì để nói
 * (bước không ghi gì, không giả định) ⇒ `undefined` — FE rơi về lý do "không đổi gì" như cũ.
 */
export const composeStepGateMessage = (input: StepGateMessageInput): string | undefined => {
  const notes = trimmed(input.notes)
  if (notes !== "") {
    // `notes` là tin cổng, nhưng chip "Đúng rồi" xác nhận mọi `new_assumptions` ⇒ điều model không nhắc thì thêm câu nói nó
    return insertAssumptions(notes, (input.newAssumptionTexts ?? []).filter((t) => !isSpokenIn(notes, t)))
  }
  const changed = summarySentence(input.summary)
  const assumed = assumptionSentence(input.newAssumptionTexts ?? [])
  if (!changed && !assumed) return undefined
  return [changed, assumed, changed ? FALLBACK_INVITE : null].filter((part): part is string => part !== null).join(" ")
}

export interface PhaseGateMessageInput {
  /** Tin nhắn cổng của bước cuối giai đoạn (đã qua `composeStepGateMessage`). */
  lastMessage?: string
  /** Câu tạm hiểu của các bước TRƯỚC trong giai đoạn mà user chưa xác nhận (bước cuối đã tự nói giả định của nó). */
  unconfirmedTexts: readonly string[]
}

/**
 * Cổng cuối giai đoạn: tin của bước cuối (đã tự nói giả định của nó) + MỌI điều còn tạm hiểu từ các bước trước, kể cả bước
 * chạy im. Không có cả hai ⇒ `undefined`.
 */
export const composePhaseGateMessage = (input: PhaseGateMessageInput): string | undefined => {
  const last = trimmed(input.lastMessage)
  const unspokenTexts = input.unconfirmedTexts.filter((t) => last === "" || !isSpokenIn(last, t))
  return last === "" ? (assumptionSentence(unspokenTexts) ?? undefined) : insertAssumptions(last, unspokenTexts)
}

/**
 * Lời thường của thao tác ở cổng, ghi vào lịch sử chat như một lượt của user: chỉ chữ của user (ghi chú sửa), hoặc câu
 * "Đúng rồi, đi tiếp" — không tiền tố kiểu "Yêu cầu sửa:" để đọc lại sau khi tải trang vẫn tự nhiên.
 */
export const gateActionText = (input: { action: "accept" | "revision" | "regenerate" | "accept_as_is"; note?: string }): string => {
  const note = trimmed(input.note)
  if (input.action === "regenerate") return "Làm lại giúp tôi"
  if (input.action === "revision") return note || "Tôi muốn sửa"
  return note || "Đúng rồi, đi tiếp"
}
