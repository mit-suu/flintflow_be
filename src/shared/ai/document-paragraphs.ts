/**
 * Mã đoạn của tài liệu upload (FLF-292): `D<số tài liệu>-P<số đoạn>`, ví dụ `D1-P03` = tài liệu 1, đoạn 3.
 *
 * Prompt đưa tài liệu cho model theo từng đoạn có mã, model trích mã đoạn làm nguồn của yêu cầu nó viết, server tra lại
 * mã ⇒ chữ gốc. Mã phải ỔN ĐỊNH qua mọi lượt gọi: số tài liệu là `docCode` lưu một lần khi upload (không phải thứ tự
 * truy vấn), số đoạn là vị trí trong `extractedText` cắt bằng đúng hàm `splitParagraphs` dưới đây — đổi luật cắt là đổi
 * mọi mã đã lưu, nên luật cắt là hợp đồng, có test.
 */

/** Khối dài hơn ngưỡng này (ký tự) thì cắt tiếp theo dòng — transcript, email dán liền không có dòng trống. */
export const LONG_BLOCK_CHARS = 700

export const PARAGRAPH_ID_RE = /^D([1-9]\d*)-P(\d{2,})$/

/** Cắt chữ đã parse thành đoạn: theo dòng trống; khối quá dài cắt tiếp theo dòng. Đoạn rỗng bị bỏ. */
export const splitParagraphs = (text: string): string[] => {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)
  const paragraphs: string[] = []
  for (const block of blocks) {
    const trimmed = block.trim()
    if (trimmed === "") continue
    if (trimmed.length <= LONG_BLOCK_CHARS) {
      paragraphs.push(trimmed)
      continue
    }
    for (const line of trimmed.split("\n")) {
      const l = line.trim()
      if (l !== "") paragraphs.push(l)
    }
  }
  return paragraphs
}

/** `D1-P03` — số đoạn 1-based, tối thiểu 2 chữ số. */
export const paragraphId = (docCode: number, index: number): string => `D${docCode}-P${String(index + 1).padStart(2, "0")}`

/** `D1-P03` ⇒ `{ docCode: 1, index: 2 }`; sai khuôn ⇒ `null`. */
export const parseParagraphId = (id: string): { docCode: number; index: number } | null => {
  const m = PARAGRAPH_ID_RE.exec(id.trim().toUpperCase())
  if (!m) return null
  const index = Number(m[2]) - 1
  return index >= 0 ? { docCode: Number(m[1]), index } : null
}

/** Chữ tài liệu cho prompt: mỗi đoạn một dòng, mở đầu bằng mã của nó. */
export const formatCodedParagraphs = (docCode: number, text: string): string =>
  splitParagraphs(text)
    .map((p, i) => `[${paragraphId(docCode, i)}] ${p}`)
    .join("\n")
