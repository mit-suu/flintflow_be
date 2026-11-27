/**
 * preview-localize.ts
 * ─────────────────────────────────────────────────────────────────
 * Chữ của bản xem trước Sửa tài liệu theo ngôn ngữ tài liệu (FLF-479 #6). Spine và op luôn là chữ gốc (tiếng Anh) nên
 * `changes[].value` / `before` hiện tiếng Anh trong khi tài liệu là tiếng Việt:
 *  - `value`: lấy từ `localized` của lô (model trả cùng `path` với op) — chính chữ sẽ được lưu thành bản dịch sau khi áp;
 *  - `before`: lấy từ Spine đã dịch (`translatedViewOf`, tra bản dịch đã có, không gọi AI).
 * Thiếu bản dịch / lệch hình dạng ⇒ giữ chữ gốc. Hàm thuần, chỉ đổi chữ hiển thị, không đổi op / path / impact.
 */

import type { LocalizedEntry } from "../../shared/ai/response-parser.js"
import { resolve } from "./path-resolver.js"
import type { Spine } from "./spine.types.js"

const isRow = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Đặt chữ dịch lên cấu trúc gốc: chỉ thay chỗ cùng hình dạng (chuỗi ⇔ chuỗi, mảng cùng độ dài, object theo khoá). */
const overlay = (source: unknown, localized: unknown): unknown => {
  if (typeof source === "string") return typeof localized === "string" && localized.trim() ? localized.trim() : source
  if (Array.isArray(source)) return Array.isArray(localized) && localized.length === source.length ? source.map((v, i) => overlay(v, localized[i])) : source
  if (isRow(source) && isRow(localized)) return Object.fromEntries(Object.entries(source).map(([k, v]) => [k, k in localized ? overlay(v, localized[k]) : v]))
  return source
}

/** Cùng hình dạng (chuỗi / mảng / object) để thay `before` bằng bản trong Spine đã dịch. */
const sameShape = (a: unknown, b: unknown): boolean =>
  typeof a === typeof b && Array.isArray(a) === Array.isArray(b) && (!Array.isArray(a) || a.length === (b as unknown[]).length)

export interface PreviewChangeText {
  path: string
  before: unknown
  value: unknown
}

export const localizeChangeText = <T extends PreviewChangeText>(change: T, view: Spine | null, localized: readonly LocalizedEntry[] | undefined): T => {
  let { before, value } = change
  const entry = localized?.find((e) => e.path === change.path)
  if (entry) value = overlay(value, entry.value)
  if (view && before !== undefined && before !== null) {
    try {
      const hit = resolve(view, change.path)
      if (hit.exists && sameShape(before, hit.value)) before = overlay(before, hit.value)
    } catch {
      // path không còn trên bản xem (phần tử mới) ⇒ giữ chữ gốc
    }
  }
  return before === change.before && value === change.value ? change : { ...change, before, value }
}
