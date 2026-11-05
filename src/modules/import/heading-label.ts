/**
 * Tiêu đề hiển thị của heading file upload (FLF-362): nhãn số Word tự đánh + chữ heading, đúng như người dùng thấy trong Word
 * ("2.1. Actors"). `heading_text` lưu trong profile / layout giữ nguyên chữ (mapping mẫu tổ chức, so sánh tải lại dựa vào
 * nó); chỉ chỗ hiển thị mới ghép nhãn. Chữ đã gõ số tay hoặc không có nhãn ⇒ giữ nguyên.
 */

import { splitHeadingNumber } from "./text-similarity.js"

export const displayHeading = (text: string, numberLabel?: string | null): string => {
  const t = text.trim()
  const label = numberLabel?.trim()
  if (!label || !t || splitHeadingNumber(t).number) return t
  return `${label} ${t}`
}
