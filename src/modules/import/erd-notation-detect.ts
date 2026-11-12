/**
 * QLHS 11/11 bug #12b: ký pháp ERD theo file upload. Tài liệu ghi rõ ký pháp (bảng danh mục hình "H7 | ERD (ký hiệu chân
 * chim) | …", chú thích "Ký hiệu: vạch ngang = phía 1, chân chim = phía nhiều", "Crow's foot notation", "IDEF1X") ⇒ dự án
 * dùng đúng ký pháp đó khi vẽ lại ERD (`Project.erdNotation`). Tất định, đọc chữ — không gọi AI; không ghi gì ⇒ `null`
 * (giữ mặc định của dự án).
 */

import type { ErdNotation } from "../../shared/diagram/erd-notation.js"

const CROWSFOOT = /crow['’]?s?[\s-]*foot|chân\s+chim|information\s+engineering\s+notation/i
const IDEF1X = /\bidef\s*-?\s*1\s*x\b/i
const CHEN = /\bchen(?:'s)?\b/i
/** "Chen" có thể là tên người ⇒ chỉ nhận khi cùng câu / dòng bảng nói về ký pháp / ERD. */
const NOTATION_CONTEXT = /\berd\b|ký\s+hiệu|ký\s+pháp|notation|thực\s+thể|entity/i

/** Ký pháp nói trong một đoạn chữ (một đoạn văn, một dòng bảng, một chú thích hình). */
export const erdNotationInText = (text: string): ErdNotation | null => {
  if (CROWSFOOT.test(text)) return "crowsfoot"
  if (IDEF1X.test(text)) return "idef1x"
  if (CHEN.test(text) && NOTATION_CONTEXT.test(text)) return "chen"
  return null
}

/** Ký pháp ERD tài liệu ghi — lần nhắc đầu tiên theo thứ tự trong file (đoạn văn, chú thích, từng dòng bảng). */
export const erdNotationOfDocument = (blocks: readonly { text: string; rows?: readonly (readonly string[])[] | null }[]): ErdNotation | null => {
  for (const b of blocks) {
    const lines = b.rows?.length ? b.rows.map((r) => r.join(" | ")) : [b.text]
    for (const line of lines) {
      const found = erdNotationInText(line)
      if (found) return found
    }
  }
  return null
}
