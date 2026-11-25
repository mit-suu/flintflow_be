/**
 * Mẫu ngoặc của chữ hướng dẫn: đoạn / ô nằm trọn trong `[ ]` hoặc `{ }` (`[Describe …]`, `{Ghi chú cho người soạn}`, chỗ điền
 * `[Name]`, `{{project name}}`), hoặc đoạn ngoặc nằm trong một câu có chữ thật (`splitInstruction`). Ngoặc tròn, `< >` và câu
 * "This section describes…" không khớp mẫu này (giá trị NFR "<= 24 h (<= 6 h …)" là nội dung). Dùng cho chữ của mẫu đã biết
 * (mẫu xuất của FlintFlow, mẫu thư viện) và nhận diện loại tài liệu (`srs-detect`).
 *
 * FLF-459 (business-flow §3.1.1, đảo FLF-364): với **file upload**, ngoặc chỉ là **một** dấu hiệu — nhận diện lúc import đi theo
 * lớp (`guidanceVerdict`): ngoặc một mình không đủ kết luận là chữ hướng dẫn.
 */
export const INSTRUCTION_PATTERNS: readonly RegExp[] = Object.freeze([/^\[[\s\S]*\]$/, /^\{[\s\S]*\}$/])

export const isInstructionText = (text: string): boolean => {
  const t = text.trim()
  return t.length > 0 && INSTRUCTION_PATTERNS.some((re) => re.test(t))
}

/** Chữ có nghĩa: không rỗng và không phải chữ hướng dẫn / ô chỗ trống (`[Name]`, `[dd/mm/yyyy]`). */
export const isRealText = (text: string | null | undefined): boolean => !!text && text.trim().length > 0 && !isInstructionText(text)

/** Bảng có ít nhất một ô chữ thật (bảng mẫu toàn `[Name]` / trống ⇒ không tính là nội dung). */
export const tableHasRealText = (rows: readonly (readonly string[])[] | null | undefined): boolean =>
  (rows ?? []).some((row) => row.some((cell) => isRealText(cell)))

/** Đoạn ngoặc trong câu: `{…}` / `{{…}}` luôn là hướng dẫn; `[…]` từ 3 từ (dẫn chiếu ngắn `[1]`, `[RFC 8446]` là nội dung). */
const INLINE = /\{\{?([^{}]+?)\}?\}|\[([^[\]]+)\]/g
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length

/**
 * Tách chữ hướng dẫn khỏi đoạn: cả đoạn trong ngoặc ⇒ toàn bộ là hướng dẫn; đoạn ngoặc trong câu có chữ thật ⇒ phần ngoặc là
 * hướng dẫn (bỏ ngoặc), `text` là phần còn lại. Không có ⇒ `guidance` rỗng, `text` nguyên văn.
 */
export const splitInstruction = (text: string): { text: string; guidance: string[] } => {
  const t = text.trim()
  if (!t) return { text: "", guidance: [] }
  if (isInstructionText(t)) return { text: "", guidance: [t.replace(/^\{\{?([\s\S]*?)\}?\}$|^\[([\s\S]*)\]$/, (_, a, b) => a ?? b).trim()] }
  const guidance: string[] = []
  const rest = t.replace(INLINE, (whole: string, curly: string | undefined, square: string | undefined) => {
    if (curly !== undefined) {
      guidance.push(curly.trim())
      return " "
    }
    if (square !== undefined && words(square) >= 3) {
      guidance.push(square.trim())
      return " "
    }
    return whole
  })
  return guidance.length ? { text: rest.replace(/\s+/g, " ").replace(/\s+([.,;:])/g, "$1").trim(), guidance } : { text: t, guidance: [] }
}

/**
 * Bảng có **nội dung** (không chỉ khung mẫu): hàng tiêu đề không tính — bảng mẫu thường là tiêu đề + hàng chỗ trống
 * (`ID | Requirement | Priority` + `[FR-xxx] | …`). Bảng một hàng coi là nhãn | giá trị: chỉ xét các ô sau cột đầu
 * (`Role | [Name]` trống, `Role | Admin` có nội dung).
 */
export const tableBodyHasRealText = (rows: readonly (readonly string[])[] | null | undefined): boolean => {
  if (!rows || rows.length === 0) return false
  return rows.length === 1 ? rows[0].slice(1).some((cell) => isRealText(cell)) : tableHasRealText(rows.slice(1))
}

// ─── FLF-459: nhận diện chữ hướng dẫn theo lớp (business-flow §3.1.1) ─────────

/**
 * Dấu hiệu lớp 3: kiểu chữ (`italic`, `color` xám / xanh, `highlight`; `format` = kiểu chữ hướng dẫn của bản ghi cũ chưa tách
 * từng loại) và chữ (`brackets` trọn đoạn `[...]` `{...}` `<<...>>`, `describes` câu kiểu "Mục này mô tả…").
 */
export type GuidanceSignal = "italic" | "color" | "highlight" | "format" | "brackets" | "describes"
/** Dấu hiệu chắc chắn lớp 1 (đọc từ OOXML): content control placeholder, style "Instruction" / "Hướng dẫn", chữ ẩn. */
export type GuidanceCertainMark = "placeholder" | "style" | "hidden"
/** 1–3: chắc là chữ hướng dẫn (Code); 4: đúng một dấu hiệu, chưa kết luận (AI phân loại trong I-4, người xác nhận). */
export type GuidanceLayer = 1 | 2 | 3 | 4

export interface GuidanceVerdict {
  layer: GuidanceLayer
  /** Lớp 1: dấu hiệu chắc chắn; lớp 2: `known`; lớp 3 / 4: các dấu hiệu tìm thấy. */
  signals: string[]
}

const WHOLE_BRACKETS: readonly RegExp[] = [/^\[[\s\S]*\]$/, /^\{[\s\S]*\}$/, /^<<[\s\S]*>>$/]
const OPEN_BRACKET = /^(?:\[|\{\{?|<<)\s*/
const CLOSE_BRACKET = /\s*(?:\]|\}\}?|>>)$/
const DESCRIBES =
  /^(?:mục|phần|chương|tiểu mục) này (?:mô tả|trình bày|liệt kê|nêu|cung cấp|giới thiệu|định nghĩa|gồm|bao gồm)|^this (?:section|subsection|part|chapter) (?:describes|provides|lists|presents|specifies|defines|contains|includes|shows|explains|outlines|gives)\b/i

/** Dấu hiệu lớp 3 đọc được từ chữ: ngoặc trọn đoạn, câu kiểu "Mục này mô tả…" / "This section describes…" (kể cả trong ngoặc). */
export const textGuidanceSignals = (text: string): GuidanceSignal[] => {
  const t = text.normalize("NFC").trim()
  if (!t) return []
  const brackets = WHOLE_BRACKETS.some((re) => re.test(t))
  const out: GuidanceSignal[] = brackets ? ["brackets"] : []
  if (DESCRIBES.test(brackets ? t.replace(OPEN_BRACKET, "") : t)) out.push("describes")
  return out
}

/** Chuẩn hoá để so câu hướng dẫn: bỏ dấu, hoa / thường, dấu câu. */
const foldGuidance = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

const stripBrackets = (s: string): string => s.trim().replace(OPEN_BRACKET, "").replace(CLOSE_BRACKET, "").trim()

/** Câu ngắn hơn ngưỡng (`[Name]`, `[Date]`) không so lớp 2 — trùng tình cờ với nội dung thật quá dễ. */
const KNOWN_MIN_WORDS = 4
/** Gần trùng: hệ số Dice theo từ của hai câu. */
const KNOWN_NEAR = 0.85

const dice = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  let common = 0
  for (const t of a) if (b.has(t)) common++
  return (2 * common) / (a.size + b.size)
}

/** Lớp 2: đoạn có trùng / gần trùng câu hướng dẫn của mẫu đã biết không. */
export type KnownGuidance = (text: string) => boolean

/**
 * Bộ so lớp 2 từ chữ hướng dẫn của các mẫu đã biết (mẫu chuẩn, mẫu thư viện org): đoạn (bỏ ngoặc) nằm trọn trong một chữ hướng
 * dẫn đã biết, hoặc gần trùng (Dice ≥ 0.85) một câu / cả đoạn của nó. Đoạn dưới 4 từ không tính.
 */
export const knownGuidanceMatcher = (texts: Iterable<string>): KnownGuidance => {
  const whole: string[] = []
  const pieces: Set<string>[] = []
  for (const raw of texts) {
    const plain = stripBrackets(raw)
    const folded = foldGuidance(plain)
    if (!folded) continue
    whole.push(` ${folded} `)
    for (const part of [plain, ...plain.split(/(?<=[.!?;])\s+|\n+/)]) {
      const words = foldGuidance(part).split(" ").filter(Boolean)
      if (words.length >= KNOWN_MIN_WORDS) pieces.push(new Set(words))
    }
  }
  if (!whole.length) return () => false
  return (text) => {
    const folded = foldGuidance(stripBrackets(text))
    const words = folded.split(" ").filter(Boolean)
    if (words.length < KNOWN_MIN_WORDS) return false
    if (whole.some((w) => w.includes(` ${folded} `))) return true
    const tokens = new Set(words)
    return pieces.some((p) => dice(tokens, p) >= KNOWN_NEAR)
  }
}

export interface GuidanceInput {
  text: string
  /** Lớp 1 (Code đọc từ file). */
  certain?: GuidanceCertainMark | null
  /** Dấu hiệu kiểu chữ của đoạn (mọi run có chữ cùng mang). */
  format?: readonly GuidanceSignal[] | null
  /** Lớp 2: câu hướng dẫn của mẫu đã biết. */
  known?: KnownGuidance | null
}

/**
 * Kết luận theo lớp, lớp trên không kết luận được mới xuống lớp dưới (business-flow §3.1.1):
 * 1. content control placeholder / style hướng dẫn / chữ ẩn ⇒ chắc chắn;
 * 2. trùng / gần trùng câu hướng dẫn của mẫu đã biết ⇒ chắc chắn;
 * 3. từ 2 dấu hiệu trở lên (kiểu chữ + chữ) ⇒ là hướng dẫn;
 * 4. đúng 1 dấu hiệu ⇒ chưa kết luận, chuyển AI phân loại (không tự coi là hướng dẫn).
 * Không dấu hiệu nào ⇒ `null` (nội dung thật).
 */
export const guidanceVerdict = (input: GuidanceInput): GuidanceVerdict | null => {
  if (!input.text.trim()) return null
  if (input.certain) return { layer: 1, signals: [input.certain] }
  if (input.known?.(input.text)) return { layer: 2, signals: ["known"] }
  const signals = [...new Set<string>([...(input.format ?? []), ...textGuidanceSignals(input.text)])]
  if (signals.length >= 2) return { layer: 3, signals }
  if (signals.length === 1) return { layer: 4, signals }
  return null
}

/** Lớp 1–3: Code đã kết luận là chữ hướng dẫn. Lớp 4 / không dấu hiệu ⇒ coi là nội dung thật (chưa chắc thì là nội dung). */
export const isCertainGuidance = (layer: GuidanceLayer | null | undefined): boolean => layer === 1 || layer === 2 || layer === 3
