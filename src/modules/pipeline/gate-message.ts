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
 *
 * FLF-260: phiên trả lời tiếng Anh có `notes` tiếng Anh. Mọi phép dò (dấu hiệu đoán, chủ ngữ tự xưng, lời mời cuối, câu đếm
 * của model) nhận cả hai ngôn ngữ bất kể phiên — dò sót thì `new_assumptions` rỗng, không điều nào được xác nhận và cờ đỏ
 * chặn ký baseline. Câu server tự dựng đi theo `language` (mặc định tiếng Việt); `gateActionText` giữ tiếng Việt vì FE
 * dựng bong bóng tức thì bằng đúng các chuỗi đó.
 */

import type { ChangeSummary } from "./pipeline.dto.js"
import { ASSUMPTION_OVERLAP_MIN_WORDS, contentWords, coversAssumption, negated, normalise, sentencesOf } from "./text-overlap.js"
import { byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"

export const FALLBACK_INVITE = "Bạn xem giúp, ổn thì mình đi tiếp nhé."
const ASSUMPTION_INVITE = "Nếu chỗ nào khác thì bạn nói tôi nhé."
/** Bản tiếng Anh của hai lời mời trên — đều phải khớp `CLOSING_INVITE_EN` để câu đếm còn chèn được trước chúng. */
const FALLBACK_INVITE_EN = "Have a look, and if it all looks right we'll move on."
const ASSUMPTION_INVITE_EN = "If anything is different, let me know."

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

/** `project` là một khối (mỗi field một dòng tóm tắt) nên câu tiếng Anh nói nguyên cụm, không đếm. */
const PROJECT_LABEL_EN = "the system overview"
/** Nhãn tiếng Anh `[số ít, số nhiều]` — câu tiếng Anh phải chia số ("1 actor", "2 new use cases"). */
const SPOKEN_LABELS_EN: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  addendum: ["note", "notes"],
  features: ["feature group", "feature groups"],
  actors: ["actor", "actors"],
  roles: ["role", "roles"],
  use_cases: ["use case", "use cases"],
  screens: ["screen", "screens"],
  permissions: ["permission", "permissions"],
  entities: ["data entity", "data entities"],
  functions: ["function", "functions"],
  validations: ["validation rule", "validation rules"],
  nfrs: ["non-functional requirement", "non-functional requirements"],
  business_rules: ["business rule", "business rules"],
  common_requirements: ["common requirement", "common requirements"],
  messages: ["message", "messages"],
  other_requirements: ["other requirement", "other requirements"],
  glossary: ["glossary term", "glossary terms"],
  diagrams: ["diagram", "diagrams"],
  custom_sections: ["custom section", "custom sections"]
})

const trimmed = (text: string | null | undefined): string => (text ?? "").trim()

/** "a" · "a và b" · "a, b và c" (tiếng Anh: "a, b and c"). */
const joinList = (items: readonly string[], language: ReplyLanguage): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${byLanguage(language, { vi: "và", en: "and" })} ${items[items.length - 1]}`

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
/** Chủ ngữ tự xưng tiếng Anh + trợ động từ + trạng từ đệm: "I", "I'm also", "we've", "I would"… Nháy cong (’) tính như nháy thẳng. */
const EN_SELF = "(i|we)(['’](m|re|ve|d|ll)|\\s+(am|are|have|would|will))?\\s+(also\\s+|still\\s+|just\\s+)?"
/** Động từ đoán tiếng Anh. Cố ý không có "supposed": "I'm supposed to …" không phải lời đoán. */
const EN_GUESS_VERB = "(assume|assumed|assuming|guess|guessed|guessing|suppose|presume|presumed|presuming)"
/**
 * Dấu hiệu đoán tiếng Anh (FLF-260), so trên chữ bỏ dấu như `HEDGE_PLAIN`: "I assume", "I'm assuming", "I guess", "I suppose",
 * "I presume", "my guess", "probably", "if not", "if that's wrong", "let me know if", "tell me if"… Cố ý không có "I think":
 * câu tiếng Anh dùng nó cả khi không đoán gì, mà phép đo này phải nghiêng về chặt. Chữ Việt bỏ dấu không tạo ra các cụm này.
 */
const HEDGE_EN = new RegExp(
  `(^|[^a-z0-9])(${EN_SELF}${EN_GUESS_VERB}|my (guess|assumption|assumptions)|probably|presumably|if not|` +
    `if (that|this|it|anything|any of (that|this))(['’]s|\\s+is)\\s+(wrong|off|different|not right|not the case)|if i['’]m wrong|` +
    `(let me know|tell me|correct me) if)(?![a-z0-9])`
)
const hasDiacritics = (text: string): boolean => /[\p{M}đĐ]/u.test(text.normalize("NFD"))
const isHedged = (sentence: string): boolean =>
  HEDGE_ACCENTED.test(sentence.toLowerCase()) ||
  HEDGE_PLAIN.test(normalise(sentence)) ||
  HEDGE_EN.test(normalise(sentence)) ||
  (!hasDiacritics(sentence) && HEDGE_UNACCENTED_TEXT.test(normalise(sentence)))

/** Đuôi mời sửa tiếng Anh mang chữ phủ định: "tell me if not", "if that's not right", "if this is not the case"… */
const NEGATED_INVITE_EN =
  /(^|[^a-z0-9])((let me know|tell me|correct me)\s+)?if\s+(not|(that|this|it|anything|any of (that|this))(['’]s|\s+is)\s+not\s+(right|correct|the case))(?![a-z0-9])/g
/**
 * Bản đưa vào phép đo phủ (`coversAssumption`), áp cho cả câu đoán lẫn điều tạm hiểu, vì phép đo so cả chiều phủ định:
 * - phủ định viết gọn ("don't", "isn't", "cannot") mở thành "not" — `text-overlap` chỉ nhận chữ "not" đứng riêng, không mở
 *   thì "patients don't need an app" khớp nhầm điều "patients need an app" (ngược nghĩa);
 * - bỏ đuôi mời sửa mang chữ phủ định — lời mời, không phải nội dung; giữ lại thì câu khẳng định thành câu phủ định: điều
 *   khẳng định không bao giờ khớp, còn điều phủ định lại khớp nhầm.
 * Chữ Việt bỏ dấu không chứa các mẫu này nên phép đo tiếng Việt không đổi.
 */
const forCoverage = (text: string): string =>
  normalise(text)
    .replace(/n['’]t(?![a-z0-9])/g, " not")
    .replace(/(^|[^a-z0-9])cannot(?![a-z0-9])/g, "$1can not")
    .replace(NEGATED_INVITE_EN, "$1")

/** Câu đã tự mang chủ ngữ ("Tôi suy ra …", "Mình hiểu là …", "I'd say …", "We …") — nối thêm tiền tố sẽ ra câu hai chủ ngữ. */
const SELF_SUBJECT = /^(tôi|mình|chúng|i|we)(?!\p{L})/iu

/** Câu tạm hiểu, chưa có lời mời cuối. Câu đã tự nói ra là lời đoán thì giữ nguyên văn, không bọc tiền tố. */
const assumptionSentences = (texts: readonly string[], language: ReplyLanguage): string[] =>
  texts
    .map((t) => stripEndPunctuation(trimmed(t)))
    .filter((t) => t !== "")
    .map((text, i) =>
      isHedged(text) || SELF_SUBJECT.test(text)
        ? ensureSentenceEnd(text)
        : byLanguage(language, {
            vi: `Tôi ${i === 0 ? "" : "cũng "}tạm hiểu là ${lowerFirst(text)}.`,
            en: `I'm ${i === 0 ? "" : "also "}assuming ${lowerFirst(text)}.`
          })
    )

/**
 * Câu nói những điều AI đang tạm hiểu, không dùng chữ "giả định". Chỉ dùng cho đường DỰ PHÒNG khi model không viết `notes`
 * — đường đó tự nói hết nên mọi điều đều được nói, mỗi điều một câu ngắn: "Tôi tạm hiểu là A. Tôi cũng tạm hiểu là B. Nếu
 * chỗ nào khác thì bạn nói tôi nhé." (tiếng Anh: "I'm assuming A. I'm also assuming B. If anything is different, let me
 * know."). Rỗng ⇒ null.
 */
export const assumptionSentence = (texts: readonly string[], language: ReplyLanguage = "vi"): string | null => {
  const sentences = assumptionSentences(texts, language)
  return sentences.length === 0 ? null : [...sentences, byLanguage(language, { vi: ASSUMPTION_INVITE, en: ASSUMPTION_INVITE_EN })].join(" ")
}

const WORD_CHAR = /[\p{L}\p{N}]/u
/**
 * `needle` có mặt trong `haystack` như một cụm trọn từ: "web" không khớp "website". Dấu chấm cuối của điều tạm hiểu từng vô
 * tình làm ranh giới phải; bỏ dấu đó (`isSpokenIn`) thì ranh giới phải được kiểm thật.
 */
const containsPhrase = (haystack: string, needle: string): boolean => {
  if (needle === "") return false
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const joinsBefore = WORD_CHAR.test(needle.charAt(0)) && WORD_CHAR.test(haystack.charAt(at - 1))
    const joinsAfter = WORD_CHAR.test(needle.charAt(needle.length - 1)) && WORD_CHAR.test(haystack.charAt(at + needle.length))
    if (!joinsBefore && !joinsAfter) return true
  }
  return false
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
  // Không tính dấu kết câu của chính điều đó: "… computers." vẫn là nguyên văn trong "… computers — tell me if not."
  const needle = normalise(stripEndPunctuation(text)).trim()
  // Nguyên văn mà câu phủ định nó ở phía sau ("… có thanh toán online là chưa cần") là nói ngược lại — so cả chiều phủ
  // định như phép đo phủ, trên bản đã bỏ đuôi "tell me if not" (xem `forCoverage`).
  const verbatim = (sentence: string): boolean =>
    negated(forCoverage(sentence)) === negated(forCoverage(text)) && containsPhrase(normalise(sentence), needle)
  // Điều quá ngắn không đủ từ nội dung để so bằng tỷ lệ ⇒ chỉ nhận khi câu đoán chứa nguyên văn nó.
  if (content.size < ASSUMPTION_OVERLAP_MIN_WORDS)
    return sentencesOf(message).some((sentence) => isHedged(sentence) && verbatim(sentence))
  // Đo phủ trên bản đã mở phủ định viết gọn và bỏ đuôi "tell me if not" (xem `forCoverage`)
  return sentencesOf(message).some(
    (sentence) => isHedged(sentence) && (verbatim(sentence) || coversAssumption(forCoverage(sentence), forCoverage(text)))
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
/** Lời mời cuối tiếng Anh (FLF-260): "… we'll move on", "go ahead", "let me know", "take a look", "looks good"… — có ranh giới từ. */
const CLOSING_INVITE_EN =
  /(^|[^a-z0-9])(move on|moving on|go ahead|carry on|keep going|continue|proceed|let me know|tell me|correct me|take a look|have a look|look (it |this |that |them )?over|review|(looks?|sounds?) (good|right|fine|ok|okay)|happy with|you agree|sign off|lock (it|this|that) in|wrap (it |this )?up|next (part|section))(?![a-z0-9])/

/** Chèn `sentence` trước lời mời cuối của `message`; không có lời mời cuối thì nối sau. */
const insertBeforeInvite = (message: string, sentence: string): string => {
  const parts = sentencesOf(message)
  const last = parts[parts.length - 1] ?? ""
  const invite = normalise(last)
  if (parts.length > 0 && (CLOSING_INVITE.test(invite) || CLOSING_INVITE_EN.test(invite))) return [...parts.slice(0, -1), sentence, last].join(" ")
  return [ensureSentenceEnd(message), sentence].join(" ")
}

/**
 * Một câu đếm cho những điều tạm hiểu mà tin cổng giai đoạn KHÔNG nói ra — ngoại lệ duy nhất của luật "tin cổng dùng nguyên
 * văn `notes`" (FLF-241). Giữ ý định FLF-232 (user biết còn nợ gì) mà bỏ cách làm cũ (nối một câu cho từng điều, đo được 8
 * câu nối nhau ở B-1.6). Vì không nói ra từng điều nên chúng KHÔNG vào `new_assumptions`; chúng ở lại `unconfirmed`, S-9.1
 * gom lại và cờ đỏ `unconfirmed_assumption` chặn ký baseline. Dùng đúng cụm "điều tôi tạm hiểu" của cờ ở
 * `deterministic-check.ts` cho đồng giọng, không dùng chữ nội bộ "giả định".
 */
const unspokenCountSentence = (count: number, language: ReplyLanguage): string =>
  byLanguage(language, {
    vi: `Còn ${count} điều tôi tạm hiểu nữa, mình rà ở phần tổng kết.`,
    en:
      count === 1
        ? "There's 1 more thing I'm assuming; we'll go over it in the summary."
        : `There are ${count} more things I'm assuming; we'll go over them in the summary.`
  })

/**
 * Câu đếm do model tự viết trong `notes`. Chỉ server được đếm — nó biết số thật từ Spine, model thì đoán: ở lượt chạy
 * 01/10 model viết "Còn 6 điều…" trong khi số thật là 4, và tin cổng B-1.6 hiện ra hai câu đếm đá nhau. `draft-to-ops` đã
 * được sửa để không đếm nữa; đây là lưới chặn, vì một câu của model không được phép làm vỡ bất biến "đúng một câu đếm".
 *
 * So trên chữ bỏ dấu và cho phép từ đệm mở đầu ("Vẫn còn…", "Hiện còn…") — model gõ không dấu và thêm từ đệm là chuyện
 * thường, cả file này đã tính tới (`HEDGE_UNACCENTED_TEXT`).
 */
const MODEL_COUNT_SENTENCE = /(^|[^a-z0-9])con\s+(\d+|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\s+dieu\s+(toi|minh)\s+tam hieu/
const EN_COUNT = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)"
/**
 * Câu đếm tiếng Anh (FLF-260): "3 more things I'm assuming …", "two other assumptions …", "4 assumptions left …", "I'm also
 * assuming 5 more things …". Khớp cả câu đếm server tự dựng, như bản tiếng Việt.
 */
const MODEL_COUNT_SENTENCE_EN = new RegExp(
  `(^|[^a-z0-9])(${EN_COUNT}\\s+(more|other|remaining|further)\\s+(assumptions?|(things?|points?)\\s+(that\\s+)?${EN_SELF}${EN_GUESS_VERB})|` +
    `${EN_COUNT}\\s+assumptions?\\s+(left|remaining|still open|outstanding)|${EN_GUESS_VERB}\\s+${EN_COUNT}\\s+(more|other)\\s+things?)(?![a-z0-9])`
)

/**
 * Bỏ mọi câu đếm do model tự viết. Phải chạy TRƯỚC khi đo "tin đã nói những điều nào": nếu đo trên bản chưa lọc thì một
 * giả định chỉ được nhắc trong câu đếm sẽ bị tính là đã nói, rồi câu đó bị bỏ đi ⇒ `new_assumptions` chứa id mà tin cuối
 * cùng không hề nói, và số của câu đếm thật bị thiếu.
 */
export const stripModelCountSentences = (message: string | null | undefined): string =>
  sentencesOf(trimmed(message))
    .filter((s) => !MODEL_COUNT_SENTENCE.test(normalise(s)) && !MODEL_COUNT_SENTENCE_EN.test(normalise(s)))
    .join(" ")
    .trim()

/** Một nhóm của câu tóm tắt tiếng Anh: "2 new use cases" · "3 screens" · "1 actor" · "the system overview". */
const spokenGroupEn =(collection: string, added: number, changed: number): string => {
  if (collection === "project") return PROJECT_LABEL_EN
  const total = added + changed
  const [one, many] = SPOKEN_LABELS_EN[collection] ?? [collection, collection]
  return `${total}${added > 0 && changed === 0 ? " new" : ""} ${total === 1 ? one : many}`
}

/** "Tôi đã cập nhật 3 use case và 2 yêu cầu phi chức năng." từ `summary[]`; không có gì đáng kể ⇒ null. */
const summarySentence = (summary: readonly ChangeSummary[], language: ReplyLanguage): string | null => {
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
    return byLanguage(language, {
      vi: added > 0 && changed === 0 ? `${added} ${label} mới` : added + changed > 1 ? `${added + changed} ${label}` : label,
      en: spokenGroupEn(collection, added, changed)
    })
  })
  if (parts.length === 0) return null
  const rest = groups.size - parts.length
  // Tiếng Anh gộp phần còn lại vào danh sách ("a, b and 2 other parts") thay vì hai chữ "and" nối nhau
  return byLanguage(language, {
    vi: `Tôi đã cập nhật ${joinList(parts, "vi")}${rest > 0 ? ` và ${rest} phần khác` : ""}.`,
    en: `I've updated ${joinList(rest > 0 ? [...parts, `${rest} other ${rest === 1 ? "part" : "parts"}`] : parts, "en")}.`
  })
}

export interface StepGateMessageInput {
  /** `notes` của lượt Draft cuối (tin nhắn cổng do model viết). */
  notes?: string | null
  summary: readonly ChangeSummary[]
  /** Câu giả định mới của bước (ngôn ngữ user) — chỉ dùng khi phải dựng tin thay cho `notes`. */
  newAssumptionTexts?: readonly string[]
  /** Ngôn ngữ trả lời của phiên (FLF-260) cho câu server tự dựng; `notes` của model đã đúng ngôn ngữ. Thiếu ⇒ tiếng Việt. */
  language?: ReplyLanguage
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
  const language = input.language ?? "vi"
  const changed = summarySentence(input.summary, language)
  const assumed = assumptionSentence(input.newAssumptionTexts ?? [], language)
  if (!changed && !assumed) return undefined
  const invite = byLanguage(language, { vi: FALLBACK_INVITE, en: FALLBACK_INVITE_EN })
  return [changed, assumed, changed ? invite : null].filter((part): part is string => part !== null).join(" ")
}

export interface PhaseGateMessageInput {
  /** Tin nhắn cổng của bước cuối giai đoạn (đã qua `composeStepGateMessage`). */
  lastMessage?: string
  /** Số điều tạm hiểu còn `unconfirmed` của giai đoạn mà tin KHÔNG nói ra — nói bằng một câu đếm, không liệt kê. */
  unspokenCount: number
  /** Ngôn ngữ của câu đếm (FLF-260). Thiếu ⇒ tiếng Việt. */
  language?: ReplyLanguage
}

/**
 * Cổng cuối giai đoạn: tin của bước cuối dùng nguyên văn, cộng một câu đếm khi còn điều tạm hiểu chưa được nói. Không có cả
 * hai ⇒ `undefined`.
 */
export const composePhaseGateMessage = (input: PhaseGateMessageInput): string | undefined => {
  // Bỏ câu đếm model tự viết trước khi thêm câu đếm thật ⇒ tin luôn có đúng một câu đếm, với số của Spine. Nơi gọi đã lọc
  // trước khi đo (xem `stripModelCountSentences`); lọc lại ở đây là bất biến tại chỗ, không phải việc lặp.
  const last = stripModelCountSentences(input.lastMessage)
  const count = input.unspokenCount > 0 ? unspokenCountSentence(input.unspokenCount, input.language ?? "vi") : null
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
