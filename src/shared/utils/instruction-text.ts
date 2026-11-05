/**
 * Chữ hướng dẫn của mẫu SRS (business-flow 1.3 "detect guidance text"; FLF-364): **chỉ chữ trong `[ ]` hoặc `{ }`** — đoạn /
 * ô nằm trọn trong ngoặc (`[Describe …]`, `{Ghi chú cho người soạn}`, chỗ điền `[Name]`, `{{project name}}`), hoặc đoạn ngoặc
 * nằm trong một câu có chữ thật (`splitInstruction`). Ngoặc tròn, `< >` và câu "This section describes…" là nội dung (trước
 * FLF-364 bị coi là hướng dẫn — giá trị NFR "<= 24 h (<= 6 h …)" bị bỏ). Màu / nghiêng chỉ là tín hiệu phụ (`guidance_format`),
 * không tự quyết. Dùng chung cho nhận diện loại tài liệu (`srs-detect`), so cấu trúc đích (I-5), cờ mục trống và chữ hướng dẫn
 * của mapping (`guidanceByHeading`).
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
