/**
 * gate-message.ts
 * ─────────────────────────────────────────────────────────────────
 * Tin nhắn của cổng duyệt (FLF-232): cổng là một tin AI viết bằng lời thường + quick reply, không còn khung liệt kê.
 * Nội dung đến từ `notes` của lượt Draft (skill `draft-to-ops` viết 2–4 câu) và dùng NGUYÊN VĂN. Không có `notes` — project
 * cũ, step tất định, hoặc model bỏ trống — thì dựng tất định từ `summary[]` và giả định mới. Cổng cuối giai đoạn lấy tin của
 * bước cuối, thêm nhiều nhất một câu đếm cho phần tạm hiểu chưa được nói. Không bước nào ở đây gọi model.
 *
 * FLF-241: server KHÔNG còn chèn câu "Tôi tạm hiểu là …" vào `notes`. Hợp đồng `new_assumptions` = đúng những gì tin nói ra
 * vẫn giữ, nhưng theo chiều ngược: `spokenAssumptionIds` cắt danh sách xuống phần tin đã nói, thay vì nhồi câu cho tin phủ
 * hết danh sách. Phần không được nói ở lại `unconfirmed` ⇒ S-9.1 gom ⇒ cờ đỏ chặn ký baseline.
 */

import type { ChangeSummary } from "./pipeline.dto.js"
import { ASSUMPTION_OVERLAP_MIN_WORDS, contentWords, coversAssumption, normalise, sentencesOf } from "./text-overlap.js"

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

const ensureSentenceEnd = (text: string): string => (/[.!?…]$/u.test(text) ? text : `${text}.`)

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

/** Câu đã tự mang chủ ngữ ("Tôi suy ra …", "Mình hiểu là …") — nối thêm tiền tố sẽ ra câu hai chủ ngữ. */
const SELF_SUBJECT = /^(tôi|mình|chúng)(?!\p{L})/iu

/** Câu tạm hiểu, chưa có lời mời cuối. Câu đã tự nói ra là lời đoán thì giữ nguyên văn, không bọc tiền tố. */
const assumptionSentences = (texts: readonly string[]): string[] =>
  texts
    .map((t) => stripEndPunctuation(trimmed(t)))
    .filter((t) => t !== "")
    .map((text, i) =>
      isHedged(text) || SELF_SUBJECT.test(text) ? ensureSentenceEnd(text) : `Tôi ${i === 0 ? "" : "cũng "}tạm hiểu là ${lowerFirst(text)}.`
    )

/**
 * Câu nói những điều AI đang tạm hiểu, không dùng chữ "giả định". Chỉ dùng cho đường DỰ PHÒNG khi model không viết `notes`
 * — đường đó tự nói hết nên mọi điều đều được nói, mỗi điều một câu ngắn: "Tôi tạm hiểu là A. Tôi cũng tạm hiểu là B. Nếu
 * chỗ nào khác thì bạn nói tôi nhé." Rỗng ⇒ null.
 */
export const assumptionSentence = (texts: readonly string[]): string | null => {
  const sentences = assumptionSentences(texts)
  return sentences.length === 0 ? null : [...sentences, ASSUMPTION_INVITE].join(" ")
}

/**
 * Lời của model đã nói điều tạm hiểu này NHƯ MỘT ĐIỀU ĐANG ĐOÁN chưa: có một câu vừa mang dấu hiệu đoán (`HEDGE`) vừa phủ
 * hết nội dung của điều đó (`coversAssumption`, so trong phạm vi CÂU không phải cả đoạn). Câu tóm tắt kể điều đó như sự thật
 * ("bệnh nhân đặt lịch trên app, còn nhân viên làm trên web") KHÔNG tính — user không biết đó là điều cần xác nhận.
 *
 * FLF-241: phép đo này quyết định điều nào ĐƯỢC XÁC NHẬN ở cổng (trước đây chỉ quyết định có chèn thêm câu hay không), nên
 * sai lệch phải nghiêng về CHẶT: coi là chưa nói thì điều đó ở lại `unconfirmed`, bị S-9.1 gom và cờ đỏ chặn ký baseline —
 * vô hại; coi là đã nói khi user chưa đọc thì ghi `confirmed` sai. Vì vậy mẫu số là CHÍNH ĐIỀU TẠM HIỂU, không phải đoạn
 * ngắn hơn: câu nói thiếu một phần không được tính (xem `coversAssumption`). Điều không có từ nội dung ⇒ chưa nói.
 */
const isSpokenIn = (message: string, text: string): boolean => {
  const content = contentWords(text)
  if (content.size === 0) return false
  const needle = normalise(text).trim()
  // Điều quá ngắn không đủ từ nội dung để so bằng tỷ lệ ⇒ chỉ nhận khi câu đoán chứa nguyên văn nó.
  if (content.size < ASSUMPTION_OVERLAP_MIN_WORDS)
    return sentencesOf(message).some((sentence) => isHedged(sentence) && normalise(sentence).includes(needle))
  return sentencesOf(message).some(
    (sentence) => isHedged(sentence) && (normalise(sentence).includes(needle) || coversAssumption(sentence, text))
  )
}

export interface GateAssumptionBrief {
  id: string
  text: string
  text_vi?: string
}

/**
 * Id của những điều tạm hiểu mà `message` thực sự nói ra. `gate_payload.new_assumptions` phải đúng tập này: chip "Đúng rồi,
 * đi tiếp" ở FE xác nhận chính xác những id trong đó (`GateCard.tsx` gọi `onConfirmAssumptions` trước khi gửi lệnh), nên id
 * nào không được tin nói ra thì không được có mặt — nếu không user xác nhận điều mình chưa đọc.
 */
export const spokenAssumptionIds = (message: string | null | undefined, assumptions: readonly GateAssumptionBrief[]): Set<string> => {
  const text = trimmed(message)
  if (text === "") return new Set()
  return new Set(assumptions.filter((a) => isSpokenIn(text, a.text_vi ?? a.text)).map((a) => a.id))
}

/**
 * Câu cuối là lời mời đi tiếp / duyệt / sửa — câu thêm vào phải chèn TRƯỚC nó, vì lời mời phải đứng cuối tin. Danh sách đi
 * theo lời thật của model: ngoài "… mình đi tiếp nhé" / "nếu khác bạn cứ nói" còn có "bạn xem qua, ổn thì mình chốt phần…",
 * "bạn đồng ý thì mình mở phần…" (gặp ở lượt chạy thật) — thiếu chúng thì câu đếm rơi xuống sau lời mời.
 */
const CLOSING_INVITE =
  /di tiep|tiep nhe|tiep nha|cu noi|noi toi|noi minh|neu (cho nao )?khac|xem giup|xem qua|xem lai|dong y thi|chot phan|sang phan|mo phan/

/** Chèn `sentence` trước lời mời cuối của `message`; không có lời mời cuối thì nối sau. */
const insertBeforeInvite = (message: string, sentence: string): string => {
  const parts = sentencesOf(message)
  const last = parts[parts.length - 1] ?? ""
  if (parts.length > 0 && CLOSING_INVITE.test(normalise(last))) return [...parts.slice(0, -1), sentence, last].join(" ")
  return [ensureSentenceEnd(message), sentence].join(" ")
}

/**
 * Một câu đếm cho những điều tạm hiểu mà tin cổng giai đoạn KHÔNG nói ra — ngoại lệ duy nhất của luật "tin cổng dùng nguyên
 * văn `notes`" (FLF-241). Giữ ý định FLF-232 (user biết còn nợ gì) mà bỏ cách làm cũ (nối một câu cho từng điều, đo được 8
 * câu nối nhau ở B-1.6). Vì không nói ra từng điều nên chúng KHÔNG vào `new_assumptions`; chúng ở lại `unconfirmed`, S-9.1
 * gom lại và cờ đỏ `unconfirmed_assumption` chặn ký baseline. Dùng đúng cụm "điều tôi tạm hiểu" của cờ ở
 * `deterministic-check.ts` cho đồng giọng, không dùng chữ nội bộ "giả định".
 */
const unspokenCountSentence = (count: number): string => `Còn ${count} điều tôi tạm hiểu nữa, mình rà ở phần tổng kết.`

/**
 * Câu đếm do model tự viết trong `notes`. Chỉ server được đếm — nó biết số thật từ Spine, model thì đoán: ở lượt chạy
 * 01/10 model viết "Còn 6 điều…" trong khi số thật là 4, và tin cổng B-1.6 hiện ra hai câu đếm đá nhau. `draft-to-ops` đã
 * được sửa để không đếm nữa; đây là lưới chặn, vì một câu của model không được phép làm vỡ bất biến "đúng một câu đếm".
 *
 * So trên chữ bỏ dấu và cho phép từ đệm mở đầu ("Vẫn còn…", "Hiện còn…") — model gõ không dấu và thêm từ đệm là chuyện
 * thường, cả file này đã tính tới (`HEDGE_UNACCENTED_TEXT`).
 */
const MODEL_COUNT_SENTENCE = /(^|[^a-z0-9])con\s+(\d+|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\s+dieu\s+(toi|minh)\s+tam hieu/

/**
 * Bỏ mọi câu đếm do model tự viết. Phải chạy TRƯỚC khi đo "tin đã nói những điều nào": nếu đo trên bản chưa lọc thì một
 * giả định chỉ được nhắc trong câu đếm sẽ bị tính là đã nói, rồi câu đó bị bỏ đi ⇒ `new_assumptions` chứa id mà tin cuối
 * cùng không hề nói, và số của câu đếm thật bị thiếu.
 */
export const stripModelCountSentences = (message: string | null | undefined): string =>
  sentencesOf(trimmed(message))
    .filter((s) => !MODEL_COUNT_SENTENCE.test(normalise(s)))
    .join(" ")
    .trim()

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
  // `notes` là tin cổng, dùng nguyên văn. Chip "Đúng rồi" xác nhận đúng những điều tin này nói ra — tập đó do
  // `spokenAssumptionIds` cắt ra khi dựng `new_assumptions`, không còn nhồi câu cho tin phủ hết danh sách (FLF-241).
  if (notes !== "") return notes
  const changed = summarySentence(input.summary)
  const assumed = assumptionSentence(input.newAssumptionTexts ?? [])
  if (!changed && !assumed) return undefined
  return [changed, assumed, changed ? FALLBACK_INVITE : null].filter((part): part is string => part !== null).join(" ")
}

export interface PhaseGateMessageInput {
  /** Tin nhắn cổng của bước cuối giai đoạn (đã qua `composeStepGateMessage`). */
  lastMessage?: string
  /** Số điều tạm hiểu còn `unconfirmed` của giai đoạn mà tin KHÔNG nói ra — nói bằng một câu đếm, không liệt kê. */
  unspokenCount: number
}

/**
 * Cổng cuối giai đoạn: tin của bước cuối dùng nguyên văn, cộng một câu đếm khi còn điều tạm hiểu chưa được nói. Không có cả
 * hai ⇒ `undefined`.
 */
export const composePhaseGateMessage = (input: PhaseGateMessageInput): string | undefined => {
  // Bỏ câu đếm model tự viết trước khi thêm câu đếm thật ⇒ tin luôn có đúng một câu đếm, với số của Spine. Nơi gọi đã lọc
  // trước khi đo (xem `stripModelCountSentences`); lọc lại ở đây là bất biến tại chỗ, không phải việc lặp.
  const last = stripModelCountSentences(input.lastMessage)
  const count = input.unspokenCount > 0 ? unspokenCountSentence(input.unspokenCount) : null
  if (last === "") return count ?? undefined
  return count ? insertBeforeInvite(last, count) : last
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

/**
 * Tin cổng mà user vừa đọc trước khi bấm, lấy từ lượt chạy đã lưu — hàm thuần.
 *
 * Thẻ cổng do FE vẽ từ **state sống**, nên chốt xong là mất và đọc lại lịch sử chỉ còn lượt bấm của user đứng
 * một mình: biết đã duyệt, không biết duyệt cái gì. Hàm này rút đúng chữ user đã đọc để ghi nó vào transcript
 * cùng lượt bấm ấy.
 *
 * Bước cuối giai đoạn ưu tiên tin của cả giai đoạn, đúng thứ tự FE đang hiển thị.
 */
export const gateMessageOfRun = (run: { gate_payload?: unknown; phase_gate?: unknown } | null): string | null => {
  const messageOf = (payload: unknown): string | null => {
    const text = (payload as { message_vi?: unknown } | null)?.message_vi
    return typeof text === "string" && text.trim() !== "" ? text : null
  }
  return messageOf(run?.phase_gate) ?? messageOf(run?.gate_payload)
}

/**
 * Id của những điều tạm hiểu mà thẻ cổng user vừa đọc THỰC SỰ nói ra, lấy từ lượt chạy đã lưu — hàm thuần.
 *
 * Cùng thứ tự ưu tiên với `gateMessageOfRun` và với thẻ FE đang vẽ (`page.tsx`: có cổng cuối giai đoạn thì lấy danh
 * sách của cổng đó, không thì của cổng bước). Phạm vi quyền phải khớp đúng chữ user đã đọc, nên lấy theo payload nào
 * đang hiển thị, kể cả khi danh sách của nó rỗng.
 *
 * Không đọc được payload nào ⇒ tập rỗng: lời sửa không đổi `status` của giả định nào. Điều chưa chốt ở lại
 * `unconfirmed`, S-9.1 gom và cờ đỏ `unconfirmed_assumption` chặn ký baseline — mất một lượt xác nhận thì user chốt
 * lại được, còn tự xác nhận hộ thì không ai thấy.
 */
export const gateAssumptionIdsOfRun = (run: { gate_payload?: unknown; phase_gate?: unknown } | null): Set<string> => {
  const payload = run?.phase_gate ?? run?.gate_payload
  const list = (payload as { new_assumptions?: unknown } | null | undefined)?.new_assumptions
  if (!Array.isArray(list)) return new Set<string>()
  return new Set(list.map((a) => (a as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string"))
}
