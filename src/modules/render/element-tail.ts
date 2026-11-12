/**
 * FLF-375 (B15) — phần tử in dạng "tiêu đề + các dòng `Nhãn: giá trị`" trong file upload, vd
 *
 *   REQ-PERF-004 – Thời gian lưu
 *   • Phát biểu: Hệ thống phải lưu dữ liệu … và nên nhập xong tệp XLSX 2.000 dòng trong vòng 30 giây.
 *   • Lý do: …
 *   • Tiêu chí chấp nhận: …
 *
 * Lúc import (FLF-366) chỉ dòng tiêu đề gắn với phần tử; các dòng "Nhãn: giá trị" thành đoạn không gắn phần tử
 * (`items: []`) ⇒ luôn in nguyên văn. CR sửa phần tử ⇒ bộ render dựng lại phần tử thành bảng FlintFlow **cạnh** các dòng
 * cũ — trùng và sai. Ở đây: các dòng đó là **đuôi** của phần tử đứng trước; phần tử đổi ⇒ giữ đúng định dạng của file,
 * chỉ thay giá trị của nhãn khớp một trường có giá trị; phần tử bị xoá ⇒ bỏ cả tiêu đề lẫn đuôi.
 */

import type { CustomBlock, Spine } from "../spine/spine.types.js"

const LINE = /^\s*([^:：\n]{2,40}?)\s*[:：]\s*([\s\S]+)$/

const norm = (s: string): string => s.normalize("NFC").toLowerCase().replace(/^[-•*\s]+/, "").replace(/\s+/g, " ").trim()

/** Nhãn dòng ⇒ trường của phần tử (Việt + Anh). Nhãn khác giữ nguyên văn. */
const LABEL_FIELDS: readonly [string, readonly string[]][] = [
  ["statement", ["phát biểu", "yêu cầu", "mô tả", "nội dung", "quy tắc", "statement", "requirement", "description", "rule"]],
  ["threshold", ["tiêu chí chấp nhận", "ngưỡng", "mục tiêu", "acceptance criteria", "acceptance", "threshold", "target"]],
  ["metric", ["chỉ số", "đo lường", "metric", "measure"]],
  ["rationale", ["lý do", "rationale"]],
  ["priority", ["mức ưu tiên", "độ ưu tiên", "ưu tiên", "priority"]]
]

const fieldOfLabel = (label: string): string | null => LABEL_FIELDS.find(([, labels]) => labels.includes(norm(label)))?.[0] ?? null

/** Khối là một dòng `Nhãn: giá trị` (đoạn hoặc mục danh sách). */
export const isLabelLine = (b: CustomBlock): boolean => (b.kind === "paragraph" || b.kind === "list_item") && LINE.test(b.text ?? "")

/** Phần tử của khoá đoạn (`nfrs:REQ-PERF-004`); không còn ⇒ `undefined`. */
export const elementOfKey = (spine: Spine, key: string): Record<string, unknown> | undefined => {
  const at = key.indexOf(":")
  if (at < 0) return undefined
  const list = (spine as unknown as Record<string, unknown>)[key.slice(0, at)]
  const id = key.slice(at + 1)
  return Array.isArray(list) ? (list.find((x) => x && typeof x === "object" && (x as { id?: unknown }).id === id) as Record<string, unknown> | undefined) : undefined
}

/** Dòng đuôi với giá trị hiện tại của phần tử (nhãn không khớp trường nào / trường trống ⇒ giữ nguyên). */
export const refreshTailBlock = (b: CustomBlock, element: Record<string, unknown>): CustomBlock => {
  const m = LINE.exec(b.text ?? "")
  if (!m) return b
  const field = fieldOfLabel(m[1])
  const value = field ? element[field] : undefined
  if (typeof value !== "string" || !value.trim()) return b
  return { ...b, text: `${m[1]}: ${value}` }
}
