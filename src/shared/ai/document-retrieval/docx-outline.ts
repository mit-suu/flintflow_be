/**
 * Heading thật của file .docx (FLF-393). `extractedText` lấy bằng `mammoth.extractRawText` nên mất style heading và số
 * mục Word tự đánh — không còn gì để dựng cây section. Lúc upload (còn buffer) đọc thêm heading qua bản HTML của mammoth
 * rồi khớp ngược về chỉ số đoạn của `splitParagraphs`, lưu thành `ProjectDocument.outline`.
 */

import { createRequire } from "module"
import type { OutlineEntry } from "./chunker.js"

const require = createRequire(import.meta.url)

export interface DocxHeading {
  level: number
  text: string
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim()

/** `<h2><a id="x"></a>Use <strong>Cases</strong></h2>` ⇒ `{ level: 2, text: "Use Cases" }`. Heading rỗng bị bỏ. */
export const headingsFromHtml = (html: string): DocxHeading[] => {
  const out: DocxHeading[] = []
  for (const m of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = normalize(decodeEntities(m[2]!.replace(/<[^>]+>/g, "")))
    if (text) out.push({ level: Number(m[1]), text })
  }
  return out
}

/** Số heading tối đa được bỏ qua khi một heading không tìm thấy trong chữ (vd heading nằm trong bảng bị cắt dòng). */
const SKIP_WINDOW = 3

/**
 * Khớp heading (theo thứ tự tài liệu) về chỉ số đoạn. Đi một lượt: đoạn trùng chữ với một trong `SKIP_WINDOW` heading
 * kế tiếp thì nhận, các heading đứng trước nó coi như không có trong chữ.
 */
export const alignOutline = (paragraphs: readonly string[], headings: readonly DocxHeading[]): OutlineEntry[] => {
  const out: OutlineEntry[] = []
  let next = 0
  paragraphs.forEach((paragraph, p) => {
    if (next >= headings.length) return
    const text = normalize(paragraph)
    for (let h = next; h < Math.min(headings.length, next + SKIP_WINDOW); h++) {
      if (headings[h]!.text === text) {
        out.push({ p, level: headings[h]!.level })
        next = h + 1
        return
      }
    }
  })
  return out
}

export const isDocx = (mimeType: string, extension: string): boolean =>
  mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || extension.toLowerCase() === ".docx"

/** Heading của file .docx theo thứ tự tài liệu. File không đọc được ⇒ ném lỗi (người gọi coi như không có outline). */
export const extractDocxHeadings = async (buffer: Buffer): Promise<DocxHeading[]> => {
  const mammoth = require("mammoth") as { convertToHtml: (input: { buffer: Buffer }) => Promise<{ value: string }> }
  const result = await mammoth.convertToHtml({ buffer })
  return headingsFromHtml(result.value)
}
