/**
 * FLF-466 phase 10 - kiểm đầu ra của lượt AI đổi tên riêng. Chữ khách là dữ liệu không tin cậy (có thể chứa câu lệnh giả), nên đầu
 * ra chỉ nhận khi **bằng chuỗi vào với các đoạn tên riêng thay bằng placeholder `{...}`**; mọi chữ nằm ngoài placeholder phải có
 * mặt, đúng thứ tự, trong chuỗi gốc. Sai ⇒ bỏ đầu ra, giữ chữ gốc cho người xem lại.
 */
import { createHash } from "node:crypto"

const PLACEHOLDER = /\{[^{}\n]{1,40}\}/g
const MAX_LEN = 300

/** Khoá ổn định theo nội dung chữ (chữ hướng dẫn / tiêu đề cột không có block id riêng). */
export const scrubKey = (text: string): string => `t_${createHash("sha1").update(text.trim()).digest("hex").slice(0, 10)}`

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** `output` hợp lệ khi bằng `original`, hoặc bằng `original` với một số đoạn thay bằng placeholder (kiểm diff). */
export const isValidScrub = (original: string, output: string): boolean => {
  const o = original.trim()
  const out = output.trim()
  if (!out || out.length > MAX_LEN) return false
  if (out === o) return true
  const parts = out.split(PLACEHOLDER)
  if (parts.length < 2) return false // đổi chữ mà không có placeholder
  const re = new RegExp(`^${parts.map(escapeRegex).join(".+?")}$`, "su")
  return re.test(o)
}
