/**
 * Chữ hướng dẫn của mẫu SRS (business-flow 1.3 "detect guidance text"): đoạn nằm trọn trong ngoặc (`[Describe …]`,
 * `<<…>>`, `{…}`, `(…)`) hoặc câu "Mục này mô tả…" / "This section describes…". Không phải nội dung của tài liệu — chỉ
 * là chỉ dẫn viết cho người soạn. Dùng chung cho nhận diện loại tài liệu (`srs-detect`), so cấu trúc đích (I-5) và cờ
 * mục trống.
 */
export const INSTRUCTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /^[[<{(].*[\]>})]$/s,
  /^(this|the) section (describes|should|lists|contains)/i,
  /^(mục|phần) này (mô tả|trình bày|liệt kê|nêu)/i
])

export const isInstructionText = (text: string): boolean => {
  const t = text.trim()
  return t.length > 0 && INSTRUCTION_PATTERNS.some((re) => re.test(t))
}

/** Chữ có nghĩa: không rỗng và không phải chữ hướng dẫn / ô chỗ trống (`[Name]`, `[dd/mm/yyyy]`). */
export const isRealText = (text: string | null | undefined): boolean => !!text && text.trim().length > 0 && !isInstructionText(text)

/** Bảng có ít nhất một ô chữ thật (bảng mẫu toàn `[Name]` / trống ⇒ không tính là nội dung). */
export const tableHasRealText = (rows: readonly (readonly string[])[] | null | undefined): boolean =>
  (rows ?? []).some((row) => row.some((cell) => isRealText(cell)))
