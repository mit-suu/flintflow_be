/**
 * elicit-brief-metrics.ts — chấm một lượt chạy luồng Brief (B-0.1) bằng phép đếm; hàm thuần, không gọi mạng.
 * ─────────────────────────────────────────────────────────────────
 * Mỗi chỉ số dưới đây là một khuyết tật **đã thật sự xảy ra** khi chạy luồng Brief, không phải chỉ số nghĩ
 * ra cho đủ bảng: option không nói được/mất, option là số trần, nhãn lồng nhau (ca khớp longest-match),
 * vốn từ nội bộ lọt ra chữ user đọc, thẻ "Nền tảng" biến mất khi user đã nêu nền tảng, giá trị B-0 bị tự
 * quyết mà không hỏi cũng không ghi giả định, và AI thêm một lượng từ user chưa nói.
 *
 * Chỉ **đếm và tập hợp**, không so chuỗi nguyên văn: model chạy ở `temperature: 0.5` nên so từng chữ thì
 * mọi lượt đều "khác nhau" và phép so giữa hai lần chạy thành vô dụng. Nguyên văn vẫn được driver in ra
 * `.md` cho người đọc xác nhận.
 */

/** Một lựa chọn trên thẻ, nguyên văn model phát. */
export interface RecordedOption {
  label: string
  description?: string
  preview?: string
}

/** Một câu hỏi tới user, ghi nguyên văn từ sự kiện `answer_needed`. */
export interface RecordedQuestion {
  /** Id hợp đồng — `Q_<topic_key>` khi câu có chủ đề (`questionIdsFor`), `Q<n>` khi không. */
  id: string
  text: string
  header?: string
  options: RecordedOption[]
  multiple?: boolean
  inline?: boolean
}

/** Một lượt hỏi đáp: tin user gửi, lời AI đáp, các câu AI hỏi trong lượt đó. */
export interface RecordedTurn {
  user_message: string
  reply: string
  questions: RecordedQuestion[]
}

/** Spine đọc lại sau khi step kết thúc — chỉ phần luồng Brief ghi. */
export interface RecordedSpine {
  form_factor: string[]
  stakes: string | null
  assumption_paths: string[]
  decisions: Array<{ topic_key: string; answer: string }>
}

export interface RecordedRun {
  case_id: string
  turns: RecordedTurn[]
  /** `null` ⇒ lượt hỏng trước khi đọc được Spine. */
  spine: RecordedSpine | null
}

export interface BriefMetrics {
  /** Số câu hỏi mỗi lượt, theo thứ tự lượt. Trần server là `MAX_QUESTIONS_PER_TURN`. */
  questions_per_turn: number[]
  /** Chủ đề đã hỏi, suy từ id câu hỏi. Thiếu `form_factor` ở ca user chưa nêu nền tảng là một khuyết tật. */
  topic_keys: string[]
  options_without_description: number
  /** Nhãn là số trần mà không có `description` nói số đó mua được gì (Rule 8). */
  numeric_only_options: number
  /** Nhãn là chuỗi con của một nhãn khác trong cùng thẻ — ca khớp longest-match. */
  nested_labels: number
  /** Thẻ tick nhiều ô có option nghĩa "không thêm gì" — tick nó cùng option khác là tự mâu thuẫn. */
  none_option_on_multiselect: number
  /** Ứng viên nêu trong ngoặc của câu hỏi mà không option nào nhận — user bị đẩy sang "Khác…". */
  candidate_without_option: string[]
  /** Mã bước, tên field, giá trị thô, từ đệm mở câu lọt ra chữ user đọc. */
  banned_vocab: string[]
  stakes_value: string | null
  has_stakes_assumption: boolean
  /** Field B-0 có giá trị mà không câu nào hỏi, không giả định nào ghi. */
  b0_fields_set_without_card_or_assumption: string[]
  /** AI thêm một lượng từ cho cụm danh từ user có nói mà user không nói lượng đó. */
  unsourced_quantifiers: number
  /** Nguyên văn các cụm bị đếm ở trên — tín hiệu có dương tính giả, người đọc xác nhận. */
  unsourced_quantifier_samples: string[]
}

// ─── vốn từ bị cấm trong chữ user đọc ────────────────────────────

/** Mã bước (`B-0.1`, `S-4`) — luật "Không chữ nội bộ" của `elicit-loop/SKILL.md`. */
const STEP_CODE = /\b[BSI]-\d+(?:\.\d+)?\b/gi

/** Tên field Spine và từ nội bộ của hệ thống. */
const BANNED_TERMS = [
  "form_factor",
  "topic_key",
  "system_name",
  "release_scope",
  "working_mode",
  "review_mode",
  "source_hash",
  "stakes",
  "addendum",
  "projection",
  "spine"
] as const

/** Giá trị thô của enum — user đọc phải thấy "web", "có quy định pháp luật", không thấy khoá. */
const BANNED_VALUES = ["web_app", "mobile_app", "desktop_app", "regulated", "internal", "production"] as const

/**
 * Từ đệm mở câu đã bị cấm ở `skill-voice-block.test.ts` — chỉ tính khi chúng **mở** lời đáp, vì luật là
 * "không mở bằng từ đệm"; cùng chữ đó ở giữa câu có thể hợp lệ.
 */
const FILLER_OPENERS = [
  "Vậy là",
  "Thế là",
  "Rõ rồi",
  "Được rồi",
  "Tuyệt vời",
  "Đã ghi nhận",
  "Đã rõ",
  "Cảm ơn bạn đã chia sẻ"
] as const

const RECOMMENDED_SUFFIX = /\s*\((khuyến nghị|recommended)\)\s*$/i

const bareLabel = (label: string): string => label.replace(RECOMMENDED_SUFFIX, "").trim()

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase()

/** Nhãn chỉ gồm số (kèm dấu phân cách, `%` hoặc đơn vị ngắn): "200", "1.000", "99.9%". */
const NUMERIC_LABEL = /^\d+(?:[.,]\d+)*\s*(%|ms|s|gb|mb)?$/i

const hasText = (s: string | undefined): boolean => (s ?? "").trim() !== ""

// ─── lượng từ không có nguồn ─────────────────────────────────────

/** Số viết bằng chữ trong tiếng Việt — cùng danh sách với định nghĩa hẹp của chỉ số. */
const SPELLED_NUMBERS = new Set(["một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín", "mười"])

/** Số giữ nguyên dấu phân cách ("1.000" là một token), chữ tách theo từ. */
const TOKEN = /\d+(?:[.,]\d+)*|\p{L}+/gu

const tokensOf = (text: string): string[] => text.toLowerCase().match(TOKEN) ?? []

const isQuantifier = (token: string): boolean => /^\d/.test(token) || SPELLED_NUMBERS.has(token)

/** `needle` xuất hiện liền mạch trong `haystack`. */
const containsPhrase = (haystack: readonly string[], needle: readonly string[]): boolean => {
  if (needle.length === 0) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true
  }
  return false
}

/** Cụm danh từ dài nhất được xét sau một lượng từ; 2 là ngắn nhất để "ba người" không thành dương tính giả. */
const PHRASE_MAX = 3
const PHRASE_MIN = 2

/**
 * Lượng từ AI thêm vào: một lượng từ đứng ngay trước cụm danh từ **user có dùng**, trong khi chính lượng từ
 * đó **không** có trong tin của user. Chỉ xét `reply` — số AI đề xuất trong `options` là đề xuất hợp lệ.
 *
 * *"nhiều file Excel"* → *"Ba file Excel"* ⇒ đếm 1 (cụm có, lượng từ không).
 */
export const unsourcedQuantifiers = (reply: string, userMessage: string): string[] => {
  const replyTokens = tokensOf(reply)
  const userTokens = tokensOf(userMessage)
  const found: string[] = []
  for (let i = 0; i < replyTokens.length; i++) {
    const quantifier = replyTokens[i]
    if (!isQuantifier(quantifier) || userTokens.includes(quantifier)) continue
    for (let len = PHRASE_MAX; len >= PHRASE_MIN; len--) {
      const phrase = replyTokens.slice(i + 1, i + 1 + len)
      if (phrase.length === len && containsPhrase(userTokens, phrase)) {
        found.push([quantifier, ...phrase].join(" "))
        break
      }
    }
  }
  return found
}

// ─── chấm ────────────────────────────────────────────────────────

/** Chủ đề của một câu hỏi: id hợp đồng là `Q_<topic_key>` (`questionIdsFor`). `Q1`, `Q2` ⇒ không có chủ đề. */
export const topicKeyOf = (questionId: string): string | null => (questionId.startsWith("Q_") ? questionId.slice(2) : null)

const bannedVocabIn = (texts: readonly string[]): string[] => {
  const hits = new Set<string>()
  for (const text of texts) {
    for (const code of text.match(STEP_CODE) ?? []) hits.add(code)
    for (const term of [...BANNED_TERMS, ...BANNED_VALUES]) {
      if (new RegExp(`\\b${term}\\b`, "i").test(text)) hits.add(term)
    }
  }
  return [...hits]
}

/** Từ đệm chỉ tính khi mở lời đáp (bỏ dấu ngoặc kép và khoảng trắng đứng trước). */
const fillerOpenerIn = (reply: string): string | null => {
  const head = reply.replace(/^["'“”\s]+/, "").toLowerCase()
  return FILLER_OPENERS.find((opener) => head.startsWith(opener.toLowerCase())) ?? null
}

/**
 * Option nghĩa "không thêm gì" trên thẻ tick nhiều ô: nó **quy chiếu ngược** về chính danh sách đang hỏi
 * ("chỉ ba vai trò **trên**", "chỉ những cái **đã nêu**") nên tick nó cùng một option khác là tự mâu thuẫn.
 *
 * Phải có **cả hai** vế mới tính: *"Chỉ web như bạn nói"* cũng mở đầu bằng "chỉ" và cũng nằm trên thẻ tick
 * nhiều ô, nhưng nó nêu một giá trị thật (web) — đó là option "giữ nguyên lời user" mà phép quyết định cố ý
 * đưa vào, bắt nhầm nó là xoá mất thứ vừa dựng.
 */
// `\b` không dùng được ở đây: nó theo nghĩa ASCII nên không thấy ranh giới cạnh chữ có dấu ("chỉ", "trên").
const NONE_OPTION = /(?:^|\s)chỉ(?:\s|$)/iu
const BACK_REFERENCE = /(?:^|\s)(trên|đã nêu|kể trên|nói ở trên)(?:[\s.,;)]|$)/iu

/** Ứng viên model liệt kê trong ngoặc đơn của câu hỏi: "(lãnh đạo khoa, kế toán, quản trị hệ thống)". */
const PARENTHETICAL = /\(([^)]{3,200})\)/g

const candidatesWithoutOption = (question: RecordedQuestion): string[] => {
  if (question.options.length === 0) return []
  const labels = question.options.map((o) => norm(bareLabel(o.label)))
  const missing: string[] = []
  for (const match of question.text.matchAll(PARENTHETICAL)) {
    const items = match[1].split(",").map((s) => norm(s)).filter((s) => s.length >= 3)
    // Một ngoặc chỉ là danh sách ứng viên khi có từ hai mục trở lên; "(Khuyến nghị)" hay chú thích một cụm thì không
    if (items.length < 2) continue
    for (const item of items) if (!labels.some((label) => label.includes(item))) missing.push(item)
  }
  return missing
}

const B0_FIELDS = ["form_factor", "stakes"] as const

export const scoreBrief = (run: RecordedRun): BriefMetrics => {
  const questions = run.turns.flatMap((t) => t.questions)
  const topicKeys = questions.flatMap((q) => topicKeyOf(q.id) ?? [])

  let optionsWithoutDescription = 0
  let numericOnlyOptions = 0
  let nestedLabels = 0
  let noneOptionOnMultiselect = 0
  const candidateWithoutOption: string[] = []
  for (const q of questions) {
    const labels = q.options.map((o) => norm(bareLabel(o.label)))
    candidateWithoutOption.push(...candidatesWithoutOption(q))
    for (const [i, option] of q.options.entries()) {
      if (q.multiple === true && NONE_OPTION.test(option.label) && BACK_REFERENCE.test(option.label)) noneOptionOnMultiselect += 1
      if (!hasText(option.description)) {
        optionsWithoutDescription += 1
        if (NUMERIC_LABEL.test(bareLabel(option.label))) numericOnlyOptions += 1
      }
      if (labels.some((other, j) => j !== i && other !== labels[i] && other.includes(labels[i]))) nestedLabels += 1
    }
  }

  const shownTexts = questions.flatMap((q) => [q.text, ...q.options.flatMap((o) => [o.label, o.description ?? ""])])
  const bannedVocab = new Set(bannedVocabIn([...run.turns.map((t) => t.reply), ...shownTexts]))
  for (const turn of run.turns) {
    const filler = fillerOpenerIn(turn.reply)
    if (filler) bannedVocab.add(filler)
  }

  // Đối chiếu với MỌI tin user đã gửi tới lượt đó, không chỉ tin của lượt: số user nêu ở lượt đầu vẫn là
  // số user đã nói khi AI nhắc lại nó ở lượt sau.
  const samples = run.turns.flatMap((t, i) => unsourcedQuantifiers(t.reply, run.turns.slice(0, i + 1).map((x) => x.user_message).join(" ")))

  const spine = run.spine
  const assumed = (field: string): boolean => (spine?.assumption_paths ?? []).some((p) => p.includes(`project.${field}`))
  const isSet = (field: (typeof B0_FIELDS)[number]): boolean =>
    field === "form_factor" ? (spine?.form_factor.length ?? 0) > 0 : (spine?.stakes ?? null) !== null

  return {
    questions_per_turn: run.turns.map((t) => t.questions.length),
    topic_keys: topicKeys,
    options_without_description: optionsWithoutDescription,
    numeric_only_options: numericOnlyOptions,
    nested_labels: nestedLabels,
    none_option_on_multiselect: noneOptionOnMultiselect,
    candidate_without_option: candidateWithoutOption,
    banned_vocab: [...bannedVocab],
    stakes_value: spine?.stakes ?? null,
    has_stakes_assumption: assumed("stakes"),
    b0_fields_set_without_card_or_assumption: spine ? B0_FIELDS.filter((f) => isSet(f) && !topicKeys.includes(f) && !assumed(f)) : [],
    unsourced_quantifiers: samples.length,
    unsourced_quantifier_samples: samples
  }
}
