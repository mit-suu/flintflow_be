/**
 * translation-units.ts
 * ─────────────────────────────────────────────────────────────────
 * Đơn vị dịch của lớp bản dịch (FLF-265 D5): một field chữ render vào SRS, khoá theo **id** (không theo chỉ số) —
 * `functions[id=FN3].normal`, `functions[id=FN3].validations[id=V1].statement`, `project.release_scope.in`.
 * Mảng chuỗi (`normal`, `abnormal`, `goals`, `tabs`, `release_scope.in/out`) là MỘT đơn vị, dịch cả mảng.
 *
 * Bản dịch khoá theo hash chữ gốc (`hashSource`), không theo key: chữ giống nhau dùng chung một bản dịch, baseline
 * cũ vẫn tra được, sửa chữ gốc ⇒ hash đổi ⇒ đơn vị thành "thiếu" (tính khi đọc, không lưu cờ).
 *
 * Danh sách field dùng chung với luật `non_english_content` (`spine/srs-text-fields.ts`). Hàm thuần, không đọc DB.
 */

import { createHash } from "node:crypto"
import type { Spine } from "../spine/spine.types.js"
import { stableStringify } from "../spine/source-hash.js"
import { parsePath, type Segment } from "../spine/path-resolver.js"
import { PROJECT_TEXT_FIELDS, SRS_TEXT_FIELDS, SRS_TEXT_GROUPS, VALIDATION_TEXT_FIELDS, type SrsTextGroup } from "../spine/srs-text-fields.js"

export type UnitValue = string | string[]

export type TranslationGroup = SrsTextGroup | "project"

/** Vị trí của đơn vị trong Spine — phase 3 dùng để dựng bản xem đã dịch. */
export interface UnitRef {
  group: TranslationGroup
  /** Id phần tử; `null` với `project`. */
  id: string | null
  /** Tên field, `release_scope.in` / `release_scope.out` với project. Validation: field của validation. */
  field: string
  /** Chỉ có với `functions[].validations[]`. */
  validation_id?: string
}

export interface TranslationUnit {
  key: string
  ref: UnitRef
  value: UnitValue
}

/** Một cặp (hash chữ gốc, bản dịch) tách từ cặp giá trị op — lưu thành `SpineTranslation`. */
export interface LocalizedUnit {
  key: string
  sourceHash: string
  /** Chữ gốc — để học glossary (tên actor / màn / entity / feature). */
  source: UnitValue
  text: UnitValue
}

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value)

/** `sha256(stableStringify(value)).slice(0, 16)` — chữ gốc giống nhau ⇒ cùng hash, không phụ thuộc thứ tự key. */
export const hashSource = (value: unknown): string => createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16)

const HAS_LETTER = /\p{L}/u

/**
 * Giá trị đáng dịch: chuỗi có chữ cái, hoặc mảng chuỗi không rỗng có ít nhất một chữ cái. `null`, rỗng, chỉ số /
 * ký hiệu (`200`, `≤ 2`) ⇒ không phải đơn vị — render in nguyên, không tính vào "thiếu".
 */
export const translatableValue = (value: unknown): UnitValue | null => {
  if (typeof value === "string") return HAS_LETTER.test(value) ? value : null
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string") && value.some((v) => HAS_LETTER.test(v))) {
    return value as string[]
  }
  return null
}

const elementPath = (group: SrsTextGroup, id: string): string => `${group}[id=${id}]`

const keyOf = (ref: UnitRef): string => {
  if (ref.group === "project") return `project.${ref.field}`
  const base = elementPath(ref.group, ref.id ?? "")
  return ref.validation_id ? `${base}.validations[id=${ref.validation_id}].${ref.field}` : `${base}.${ref.field}`
}

/** `release_scope` tách hai đơn vị `release_scope.in` / `release_scope.out`; còn lại một field một đơn vị. */
const PROJECT_UNIT_FIELDS: string[] = PROJECT_TEXT_FIELDS.flatMap((field) =>
  field === "release_scope" ? ["release_scope.in", "release_scope.out"] : [field]
)

const fieldValue = (row: unknown, field: string): unknown =>
  field.split(".").reduce<unknown>((acc, part) => (isRow(acc) ? acc[part] : undefined), row)

const unitOf = (ref: UnitRef, raw: unknown): TranslationUnit[] => {
  const value = translatableValue(raw)
  return value === null ? [] : [{ key: keyOf(ref), ref, value }]
}

const projectUnits = (project: unknown): TranslationUnit[] =>
  PROJECT_UNIT_FIELDS.flatMap((field) => unitOf({ group: "project", id: null, field }, fieldValue(project, field)))

/** `id` chuỗi không rỗng của một phần tử; không có ⇒ `undefined`. */
const idOf = (row: Row): string | undefined => (typeof row.id === "string" && row.id ? row.id : undefined)

/** Field chữ của chính phần tử (không gồm validation lồng). */
const ownUnits = (group: SrsTextGroup, id: string, element: Row): TranslationUnit[] =>
  (SRS_TEXT_FIELDS[group] as readonly string[]).flatMap((field) => unitOf({ group, id, field }, element[field]))

const elementUnits = (group: SrsTextGroup, element: unknown): TranslationUnit[] => {
  if (!isRow(element)) return []
  const id = idOf(element)
  if (!id) return []
  const own = ownUnits(group, id, element)
  if (group !== "functions" || !Array.isArray(element.validations)) return own
  return [...own, ...element.validations.flatMap((v) => validationUnits(id, v))]
}

const validationUnits = (functionId: string, validation: unknown, fallbackId?: string): TranslationUnit[] => {
  if (!isRow(validation)) return []
  const vid = idOf(validation) ?? fallbackId
  if (!vid) return []
  return VALIDATION_TEXT_FIELDS.flatMap((field) =>
    unitOf({ group: "functions", id: functionId, field, validation_id: vid }, validation[field])
  )
}

/**
 * Mọi đơn vị dịch của Spine theo bảng §2.1: `project` rồi từng collection theo thứ tự `SRS_TEXT_FIELDS`. Không có
 * `custom_sections` (mode 1), `addendum`, `assumptions`, `*_vi`, id / mã / enum. Nhóm vắng mặt ⇒ không có đơn vị.
 */
export const translationUnits = (spine: Partial<Pick<Spine, "project" | SrsTextGroup>>): TranslationUnit[] => [
  ...(spine.project ? projectUnits(spine.project) : []),
  ...SRS_TEXT_GROUPS.flatMap((group) => ((spine[group] ?? []) as unknown[]).flatMap((element) => elementUnits(group, element)))
]

// ─── cặp (giá trị Anh, giá trị dịch) của một op — FLF-265 D16 ───────

/**
 * Chữ dịch dùng được cho chữ gốc `source`, đã trim — `null` nếu lệch hình dạng hoặc rỗng (không ghi rác):
 * chuỗi ⇔ chuỗi không rỗng; mảng ⇔ mảng chuỗi CÙNG độ dài, phần tử gốc có chữ thì phần tử dịch không được rỗng.
 * Dùng chung cho lượt AI trả kèm (`unitsOfValue`), dịch theo lô (`acceptBatchItems`) và lúc tra bản đã lưu.
 */
export const fitTranslation = (source: UnitValue, localized: unknown): UnitValue | null => {
  if (typeof source === "string") return typeof localized === "string" && localized.trim() ? localized.trim() : null
  if (!Array.isArray(localized) || localized.length !== source.length || !localized.every((v) => typeof v === "string")) return null
  const trimmed = (localized as string[]).map((v) => v.trim())
  return trimmed.every((v, i) => v !== "" || !source[i].trim()) ? trimmed : null
}

/** Từ thứ 3 trở lên ⇒ câu, không phải tên / thuật ngữ (tên ngắn giữ nguyên tiếng Anh là bình thường). */
const MIN_SENTENCE_WORDS = 3
const isSentence = (text: string): boolean => text.trim().split(/\s+/).length >= MIN_SENTENCE_WORDS

/**
 * Model chép nguyên câu gốc thay vì dịch ⇒ không phải bản dịch. Lưu lại thì đơn vị không còn "thiếu", dịch theo lô bỏ
 * qua, mà không có sửa tay (D7) ⇒ tài liệu hiện tiếng Anh mãi. Dùng chung cho lượt AI trả kèm (`localizedUnitsOf`) và
 * dịch theo lô (`acceptBatchItems`): bỏ ⇒ giữ "thiếu". Tên ngắn (< 3 từ) giữ nguyên tiếng Anh là bình thường ⇒ nhận.
 */
export const copiedSource = ({ source, text }: Pick<LocalizedUnit, "source" | "text">): boolean => {
  const sourceList = typeof source === "string" ? [source] : source
  const textList = typeof text === "string" ? [text] : text
  return (
    sourceList.length === textList.length &&
    sourceList.every((value, i) => value.trim() === textList[i].trim()) &&
    sourceList.some(isSentence)
  )
}

/** Ghép một đơn vị với chữ dịch cùng vị trí (`fitTranslation`). Lệch hình dạng / rỗng ⇒ bỏ đơn vị (giữ "thiếu"). */
const pairOf = (unit: TranslationUnit, localized: unknown): LocalizedUnit[] => {
  const text = fitTranslation(unit.value, localized)
  return text === null ? [] : [{ key: unit.key, sourceHash: hashSource(unit.value), source: unit.value, text }]
}

/**
 * Id tạm theo vị trí cho phần tử op `add` CHƯA có id — skill `apply-change-op` dặn model bỏ `id` khi thêm mới (server
 * cấp id lúc áp op). Hash không phụ thuộc id và key của cặp không được lưu (chỉ để nhận diện tên cho glossary) ⇒ không
 * cần id thật để lưu bản dịch. Tiền tố `$add` không trùng id tạm `$new<n>` của model.
 */
const positionalId = (index: number): string => `$add${index}`

/**
 * Phần tử dịch cùng id; bản dịch bỏ id thì ghép theo vị trí khi hai mảng cùng độ dài. Phần tử Anh không có id ⇒ chỉ
 * ghép theo vị trí (không tra theo id — `undefined === undefined` sẽ gán mọi phần tử vào mục đầu thiếu id).
 */
const counterpart = (enList: unknown[], locList: unknown, index: number, id: string | undefined): unknown => {
  if (!Array.isArray(locList)) return undefined
  const byId = id === undefined ? undefined : locList.find((row) => isRow(row) && row.id === id)
  if (byId !== undefined) return byId
  const at = locList.length === enList.length ? locList[index] : undefined
  return isRow(at) && (at.id === undefined || at.id === id) ? at : undefined
}

/** Giá trị là một phần tử hoặc mảng phần tử (`add functions[]`, `set screens`); `pair` nhận vị trí để dựng id tạm. */
const pairElements = (en: unknown, loc: unknown, pair: (en: unknown, loc: unknown, index: number) => LocalizedUnit[]): LocalizedUnit[] => {
  if (!Array.isArray(en)) return pair(en, loc, 0)
  if (!Array.isArray(loc)) return []
  return en.flatMap((row, index) => (isRow(row) ? pair(row, counterpart(en, loc, index, idOf(row)), index) : []))
}

/** Cặp của một validation; `fallbackId` = id trên path hoặc id tạm theo vị trí (validation mới chưa có id). */
const pairValidation = (functionId: string, en: unknown, loc: unknown, fallbackId: string): LocalizedUnit[] =>
  isRow(loc) ? validationUnits(functionId, en, fallbackId).flatMap((unit) => pairOf(unit, loc[unit.ref.field])) : []

/**
 * Cặp của một phần tử: field chữ của nó + validation lồng (ghép theo id, thiếu id thì theo vị trí). `fallbackId` = id
 * trên path (`functions[id=FN3]`) hoặc id tạm theo vị trí của op `add` chưa có id.
 */
const pairElement = (group: SrsTextGroup, en: unknown, loc: unknown, fallbackId: string): LocalizedUnit[] => {
  if (!isRow(en) || !isRow(loc)) return []
  if (loc.id !== undefined && en.id !== undefined && loc.id !== en.id) return []
  const id = idOf(en) ?? fallbackId
  const own = ownUnits(group, id, en).flatMap((unit) => pairOf(unit, loc[unit.ref.field]))
  if (group !== "functions" || !Array.isArray(en.validations)) return own
  return [...own, ...pairElements(en.validations, loc.validations, (v, l, index) => pairValidation(id, v, l, positionalId(index)))]
}

const isMatchById = (segment: Segment): string | null =>
  segment.selector?.kind === "match" && segment.selector.pairs.length === 1 && segment.selector.pairs[0][0] === "id"
    ? segment.selector.pairs[0][1]
    : null

const isCollectionTarget = (segment: Segment): boolean => !segment.selector || segment.selector.kind === "append"

const projectPairs = (rest: Segment[], en: unknown, loc: unknown): LocalizedUnit[] => {
  if (rest.some((segment) => segment.selector)) return []
  const prefix = rest.map((segment) => segment.key).join(".")
  // `project` cả object · `project.release_scope` · `project.vision` · `project.release_scope.in`
  return PROJECT_UNIT_FIELDS.flatMap((field) => {
    if (prefix && field !== prefix && !field.startsWith(`${prefix}.`)) return []
    const sub = prefix ? field.slice(prefix.length + 1) : field
    const enValue = sub ? fieldValue(en, sub) : en
    const locValue = sub ? fieldValue(loc, sub) : loc
    return unitOf({ group: "project", id: null, field }, enValue).flatMap((unit) => pairOf(unit, locValue))
  })
}

const validationPairs = (functionId: string, rest: Segment[], en: unknown, loc: unknown): LocalizedUnit[] => {
  const [head, field, ...tail] = rest
  if (tail.length > 0) return []
  if (isCollectionTarget(head)) {
    return field ? [] : pairElements(en, loc, (e, l, index) => pairValidation(functionId, e, l, positionalId(index)))
  }
  const vid = isMatchById(head)
  if (!vid) return []
  if (!field) return pairValidation(functionId, en, loc, vid)
  if (field.selector || !(VALIDATION_TEXT_FIELDS as readonly string[]).includes(field.key)) return []
  return unitOf({ group: "functions", id: functionId, field: field.key, validation_id: vid }, en).flatMap((unit) => pairOf(unit, loc))
}

/**
 * Từ một cặp (giá trị Anh của op, giá trị dịch cùng `path`) ⇒ các cặp (hash câu Anh, câu dịch) theo bảng §2.1.
 * Nhận: phần tử cả object (`functions[]`, `functions[id=FN3]`), field (`functions[id=FN3].normal`), validation lồng
 * (`functions[id=FN3].validations[]`, `…validations[id=V1].statement`), `project` / `project.<field>`. Phần tử `add` chưa
 * có id (server cấp lúc áp op) ⇒ id tạm theo vị trí (`positionalId`), vẫn ra cặp. Path lạ, field
 * không phải chữ SRS, selector vô hướng (`tabs[=X]`), hình dạng lệch ⇒ bỏ đúng đơn vị đó. Op `remove` do nơi gọi lọc.
 */
export const unitsOfValue = (path: string, enValue: unknown, localizedValue: unknown): LocalizedUnit[] => {
  let segments: Segment[]
  try {
    segments = parsePath(path)
  } catch {
    return []
  }
  const [head, ...rest] = segments
  if (head.key === "project") return head.selector ? [] : projectPairs(rest, enValue, localizedValue)
  if (!(SRS_TEXT_GROUPS as string[]).includes(head.key)) return []
  const group = head.key as SrsTextGroup

  if (isCollectionTarget(head)) {
    return rest.length > 0 ? [] : pairElements(enValue, localizedValue, (en, loc, index) => pairElement(group, en, loc, positionalId(index)))
  }
  const id = isMatchById(head)
  if (!id) return []
  if (rest.length === 0) return pairElement(group, enValue, localizedValue, id)
  if (group === "functions" && rest[0].key === "validations") return validationPairs(id, rest, enValue, localizedValue)
  if (rest.length !== 1 || rest[0].selector || !(SRS_TEXT_FIELDS[group] as readonly string[]).includes(rest[0].key)) return []
  return unitOf({ group, id, field: rest[0].key }, enValue).flatMap((unit) => pairOf(unit, localizedValue))
}
