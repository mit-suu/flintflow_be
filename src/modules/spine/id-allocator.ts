/**
 * id-allocator.ts
 * ─────────────────────────────────────────────────────────────────
 * Id của phần tử mới do SERVER cấp, không do model tự đánh (FLF-177 fix-plan WP-2 — BUG-02, BUG-08, BUG-35).
 *
 * Model tự đặt id dễ trùng id đã có (`A03`, `FN005`) ⇒ `set` đè lên phần tử khác thay vì `add`; hoặc đặt id
 * không có thật (`UC18`) rồi `set` vào đó ⇒ `path_not_resolved`. Từ nay op `add` vào collection có id được
 * phép **bỏ trống `id`** hoặc gửi id tạm `$new1`, `$newReminder`…; op engine cấp id kế tiếp theo đúng định
 * dạng của collection, và thay mọi tham chiếu tới id tạm ở các op sau trong cùng lô.
 *
 * Định dạng: tiền tố + số, độ rộng = max(độ rộng mặc định, độ rộng dài nhất đang có) — `FN01..FN04` (S-4.4
 * cũ) cùng tồn tại với `FN001..` thì phần tử mới vẫn là `FN005`, không sinh thêm kiểu thứ ba.
 * `validations` lồng trong function: `<function id>-V<n>`, duy nhất trên toàn Spine (bất biến 3 coi id
 * validation là một không gian chung).
 */

import type { Spine } from "./spine.types.js"

export interface IdFormat {
  prefix: string
  width: number
}

/** Định dạng mặc định theo fixture 19 màn (`fixtures/spine-fixture-19-screens.json`) và skill content. */
export const ID_FORMATS: Readonly<Record<string, IdFormat>> = Object.freeze({
  features: { prefix: "F", width: 1 },
  actors: { prefix: "A", width: 2 },
  roles: { prefix: "R", width: 1 },
  use_cases: { prefix: "UC", width: 2 },
  screens: { prefix: "S", width: 2 },
  permissions: { prefix: "P", width: 3 },
  entities: { prefix: "E", width: 2 },
  functions: { prefix: "FN", width: 3 },
  nfrs: { prefix: "N", width: 2 },
  business_rules: { prefix: "BR", width: 2 },
  common_requirements: { prefix: "CR", width: 2 },
  messages: { prefix: "MSG", width: 2 },
  other_requirements: { prefix: "OR", width: 2 },
  glossary: { prefix: "G", width: 2 },
  addendum: { prefix: "AD", width: 2 },
  custom_sections: { prefix: "CS", width: 2 },
  diagrams: { prefix: "D", width: 2 },
  assumptions: { prefix: "AS", width: 2 },
  decisions: { prefix: "DC", width: 2 },
  flags: { prefix: "FL", width: 3 },
  baselines: { prefix: "BL", width: 3 }
})

/** Id tạm do model đặt: `$new1`, `$newReminder`. Chữ cái sau `$` — "$50" trong văn bản không phải id tạm. */
export const PLACEHOLDER_ID_RE = /\$[A-Za-z][A-Za-z0-9_]*/g

export const isPlaceholderId = (value: unknown): value is string => typeof value === "string" && /^\$[A-Za-z][A-Za-z0-9_]*$/.test(value)

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Id kế tiếp cho danh sách `existing` theo `format`. */
export const nextIdIn = (existing: readonly string[], format: IdFormat): string => {
  const re = new RegExp(`^${escapeRe(format.prefix)}(\\d+)$`)
  let max = 0
  let width = format.width
  for (const id of existing) {
    const m = re.exec(id)
    if (!m) continue
    max = Math.max(max, Number(m[1]))
    width = Math.max(width, m[1].length)
  }
  const taken = new Set(existing)
  for (let n = max + 1; ; n++) {
    const candidate = `${format.prefix}${String(n).padStart(width, "0")}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Collection này có được server cấp id không. */
export const allocatesIds = (collection: string): boolean => collection === "validations" || collection in ID_FORMATS

/**
 * Id mới cho một phần tử thêm vào `collection`. `parentId` chỉ dùng cho `validations` (id function cha).
 * `null` ⇒ collection không do allocator quản lý (vd `steps`, `sections` — khoá có nghĩa, không đánh số).
 */
export const allocateId = (spine: Spine, collection: string, parentId: string | null = null): string | null => {
  if (collection === "validations") {
    if (!parentId) return null
    const all = spine.functions.flatMap((f) => f.validations.map((v) => v.id))
    return nextIdIn(all, { prefix: `${parentId}-V`, width: 1 })
  }
  const format = ID_FORMATS[collection]
  if (!format) return null
  const list = (spine as unknown as Record<string, unknown>)[collection]
  const ids = Array.isArray(list)
    ? list.map((el) => (typeof el === "object" && el !== null ? (el as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === "string")
    : []
  return nextIdIn(ids, format)
}

/** Thay id tạm đã được cấp trong chuỗi (path, hoặc giá trị như `assumptions[].path`). */
export const substitutePlaceholders = (text: string, mapping: ReadonlyMap<string, string>): string =>
  mapping.size === 0 ? text : text.replace(PLACEHOLDER_ID_RE, (token) => mapping.get(token) ?? token)

/** Như `substitutePlaceholders` nhưng đi sâu vào object/mảng — không đụng key, chỉ giá trị chuỗi. */
export const substituteDeep = (value: unknown, mapping: ReadonlyMap<string, string>): unknown => {
  if (mapping.size === 0) return value
  if (typeof value === "string") return substitutePlaceholders(value, mapping)
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, mapping))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteDeep(v, mapping)]))
  }
  return value
}
