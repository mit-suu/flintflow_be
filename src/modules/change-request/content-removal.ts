/**
 * FLF-483 (M1-a, plan fix #14): "xoá nội dung" của CR không chỉ là op `remove`. Op `set` thay một mảng con có id
 * (`validations[]`, `steps[]`… của một phần tử) bằng mảng ngắn hơn cũng làm mất mục con, nhưng trước đây vẫn tự ghi ở mức
 * "Chỉ ở mốc chốt". Hàm thuần — không DB.
 * Mảng chuỗi ngắn đi (`normal[]`) **không** tính: đó là sửa câu bình thường, tính vào thì CR nào cũng dừng (plan "Cần chốt" 4b).
 */

import type { Spine } from "../spine/spine.types.js"
import { elementValue } from "./spine-location.js"

type Row = Record<string, unknown>

const isRow = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v)

/** Op xoá (`remove`) — kể cả phần tử con. */
export const isRemoveOp = (op: unknown): boolean => isRow(op) && op.op === "remove"

/** Đề xuất có op `remove` nào không. */
export const hasRemoveOp = (proposal: { spine_ops?: readonly unknown[] } | null | undefined): boolean => (proposal?.spine_ops ?? []).some(isRemoveOp)

const LABEL_FIELDS = ["name", "title", "term", "condition", "text", "description", "statement", "content", "message", "action", "label", "rule"] as const

/** Nhãn đọc được của một mục (không in mã nội bộ nếu có chữ; chỉ còn id khi không có field chữ nào). */
const labelOf = (value: unknown): string => {
  if (!isRow(value)) return typeof value === "string" ? value.trim() : ""
  const text = LABEL_FIELDS.map((f) => value[f]).find((v): v is string => typeof v === "string" && v.trim().length > 0)
  const id = typeof value.id === "string" ? value.id : ""
  const label = text ? (id && !text.includes(id) ? `${id} ${text}` : text) : id
  return label.length > 120 ? `${label.slice(0, 117)}...` : label
}

/** Mọi object có `id` nằm trong một mảng bên dưới `value` (không tính chính `value`), khoá theo đường dẫn field + id. */
const idItems = (value: unknown, trail = "", out = new Map<string, unknown>()): Map<string, unknown> => {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRow(item) && "id" in item && item.id !== undefined && item.id !== null) out.set(`${trail}#${String(item.id)}`, item)
      idItems(item, isRow(item) && "id" in item ? `${trail}#${String(item.id)}` : trail, out)
    }
  } else if (isRow(value)) {
    for (const [k, v] of Object.entries(value)) idItems(v, `${trail}.${k}`, out)
  }
  return out
}

/**
 * Mục bị xoá khỏi các phần tử `paths` (path phần tử mà op của CR chạm tới) giữa `before` và `after`:
 * - phần tử có ở trước mà không còn ở sau (op `remove` cả phần tử) ⇒ một mục;
 * - mục con có `id` (kể cả lồng) có ở trước mà không còn ở sau ⇒ một mục.
 * Phần tử mới thêm, mảng chuỗi ngắn đi ⇒ không tính.
 */
export const removedItems = (before: Spine, after: Spine, paths: readonly string[]): { path: string; label: string }[] => {
  const out: { path: string; label: string }[] = []
  for (const path of new Set(paths)) {
    const was = elementValue(before, path)
    if (was === undefined) continue
    const now = elementValue(after, path)
    if (now === undefined) {
      out.push({ path, label: labelOf(was) })
      continue
    }
    const kept = idItems(now)
    for (const [key, item] of idItems(was)) if (!kept.has(key)) out.push({ path, label: labelOf(item) })
  }
  return out
}
