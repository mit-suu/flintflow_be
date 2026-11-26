/**
 * FLF-483 (lỗi #32): CR đổi một giá trị cụ thể ("4 tiếng" thành "6 tiếng") nhưng model chỉ sửa một phần của phần tử — Luồng
 * ngoại lệ đã ghi 6 giờ, còn Luồng chính và Kiểm tra dữ liệu vẫn ghi 4 giờ. Hàm thuần: so từng đoạn chữ của phần tử trước /
 * sau đề xuất; giá trị nào đã bị thay ở ít nhất một đoạn mà vẫn còn nguyên ở đoạn khác (cùng phần tử) ⇒ "giá trị cũ còn sót".
 * So theo dạng chuẩn hoá của `literal-values.ts` (4 tiếng = 4 giờ = 4 hours). Không đọc `source_ref` (nguồn gốc, lịch sử) và mã.
 */

import { fieldLabel, pathLabel } from "../spine/human-labels.js"
import type { Spine } from "../spine/spine.types.js"
import type { IChangeLocation, VerifyViolation } from "./change-location.model.js"
import { literalValues } from "./literal-values.js"
import { screenSpecOf } from "../diagram/renderers/screen-mockup.js"
import { elementValue, isArrayPath, listElements } from "./spine-location.js"

export interface TextLeaf {
  /** Khoá ổn định của đoạn chữ trong phần tử (`normal[3]`, `validations[id=FN005-V2].statement`). */
  key: string
  /** Nhãn cho người đọc ("Luồng chính bước 4", "Kiểm tra dữ liệu"). */
  label: string
  text: string
}

export interface OldValueLeft {
  /** Giá trị cũ như viết trong tài liệu ("4 hours"). */
  value: string
  /** Dạng chuẩn hoá — khoá so khớp. */
  folded: string
  /** Nhãn các chỗ còn ghi giá trị đó, không trùng. */
  places: string[]
}

/** Trường không xét: nguồn gốc, mã. */
const SKIPPED_FIELDS: ReadonlySet<string> = new Set(["source_ref", "id"])
/** Mảng chuỗi mà thứ tự là bước ("Luồng chính bước 4"). */
const STEP_FIELDS: ReadonlySet<string> = new Set(["normal", "abnormal"])

const itemKey = (item: unknown, index: number): string => {
  const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined
  return typeof id === "string" ? `id=${id}` : String(index)
}

const walk = (value: unknown, key: string, top: string, index: number | null, out: TextLeaf[]): void => {
  if (typeof value === "string") {
    const base = fieldLabel(top)
    const label = index !== null && STEP_FIELDS.has(top) ? `${base} bước ${index + 1}` : base
    if (value.trim()) out.push({ key, label, text: value })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${key}[${itemKey(item, i)}]`, top, STEP_FIELDS.has(top) ? i : null, out))
    return
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SKIPPED_FIELDS.has(k) || k.endsWith("_ids")) continue
      walk(v, `${key}.${k}`, top, index, out)
    }
  }
}

/** Mọi đoạn chữ của một phần tử Spine (bỏ `source_ref`, mã, mảng mã). */
export const textLeaves = (element: unknown): TextLeaf[] => {
  const out: TextLeaf[] = []
  if (element && typeof element === "object") {
    for (const [field, v] of Object.entries(element as Record<string, unknown>)) {
      if (SKIPPED_FIELDS.has(field) || field.endsWith("_ids")) continue
      walk(v, field, field, null, out)
    }
  }
  return out
}

const foldedOf = (text: string): Set<string> => new Set(literalValues(text).map((l) => l.folded))

/**
 * Giá trị mà đề xuất ĐÃ thay ở ít nhất một đoạn chữ (đoạn đó có giá trị trước, không còn sau). Dạng chuẩn hoá ⇒ cách
 * viết thô ("4 hours"). Đoạn bị xoá hẳn / mới thêm không tính là "thay".
 */
export const replacedValues = (before: unknown, after: unknown): Map<string, string> => {
  const afterByKey = new Map(textLeaves(after).map((l) => [l.key, l]))
  const out = new Map<string, string>()
  for (const leaf of textLeaves(before)) {
    const now = afterByKey.get(leaf.key)
    if (!now) continue
    const stillThere = foldedOf(now.text)
    for (const lit of literalValues(leaf.text)) if (!stillThere.has(lit.folded) && !out.has(lit.folded)) out.set(lit.folded, lit.raw)
  }
  return out
}

/** Giá trị đã bị thay ở chỗ này mà vẫn còn ở đoạn khác của chính phần tử sau đề xuất (`after`). */
export const oldValuesLeft = (before: unknown, after: unknown): OldValueLeft[] => {
  const replaced = replacedValues(before, after)
  if (!replaced.size) return []
  const unchangedBefore = new Map(textLeaves(before).map((l) => [l.key, l.text]))
  const found = new Map<string, OldValueLeft>()
  for (const leaf of textLeaves(after)) {
    // Chỉ đoạn đã có giá trị đó từ trước (đoạn mới thêm có thể cố ý nhắc giá trị cũ để so sánh)
    const was = unchangedBefore.get(leaf.key)
    if (was === undefined) continue
    const wasValues = foldedOf(was)
    for (const lit of literalValues(leaf.text)) {
      if (!replaced.has(lit.folded) || !wasValues.has(lit.folded)) continue
      const entry = found.get(lit.folded) ?? { value: replaced.get(lit.folded)!, folded: lit.folded, places: [] }
      if (!entry.places.includes(leaf.label)) entry.places.push(leaf.label)
      found.set(lit.folded, entry)
    }
  }
  return [...found.values()]
}

/** Câu báo cho người đọc: nêu giá trị và nhãn chỗ còn sót, không nêu đường dẫn. */
export const oldValueLeftMessage = (elementLabel: string, left: readonly OldValueLeft[]): string =>
  left
    .map((l) => `${elementLabel} còn ghi giá trị cũ “${l.value}” ở ${l.places.join(", ")} - cần đổi cho khớp yêu cầu (hoặc giữ nguyên nếu con số này mang nghĩa khác)`)
    .join("; ")

/** Chữ của mọi hình mockup/ spec và phần tử còn giá trị cũ: dùng cho lượt quét sau khi ghi. */
export const leavesWithValues = (element: unknown, folded: ReadonlySet<string>): { label: string; value: string }[] => {
  const out: { label: string; value: string }[] = []
  for (const leaf of textLeaves(element)) {
    const hit = literalValues(leaf.text).find((l) => folded.has(l.folded))
    if (hit) out.push({ label: leaf.label, value: hit.raw })
  }
  return out
}

export const OLD_VALUE_LEFT_RULE = "old_value_left"

type OldValueLocation = Pick<IChangeLocation, "location_id" | "path" | "conclusion" | "proposal"> & Partial<Pick<IChangeLocation, "manual" | "redo_count" | "kept_violations">>

const parsed = (json: string | null | undefined): unknown => {
  if (!json) return undefined
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** Số vòng AI làm lại được cho luật này trước khi hạ xuống cảnh báo (quyết định 1: chặn một vòng). */
export const OLD_VALUE_BLOCK_ROUNDS = 1

/**
 * Luật `old_value_left` cho từng vị trí `edit`: phần tử sau đề xuất còn ghi giá trị mà chính đề xuất đã đổi ở chỗ khác.
 * Vòng đầu (vị trí chưa được AI làm lại, không phải sửa tay) ⇒ lỗi chặn, AI soạn lại; từ vòng sau (hoặc sửa tay) ⇒ nhận xét
 * vàng, không chặn ghi. Vị trí BA đã "giữ nguyên" luật này không báo nữa.
 */
export const checkOldValueLeft = (spine: Spine, locations: readonly OldValueLocation[]): { violations: Map<string, VerifyViolation[]>; flags: Map<string, { rule: string; message: string }[]> } => {
  const violations = new Map<string, VerifyViolation[]>()
  const flags = new Map<string, { rule: string; message: string }[]>()
  for (const l of locations) {
    if (l.conclusion !== "edit" || !l.proposal || isArrayPath(l.path)) continue
    if (l.kept_violations?.includes(OLD_VALUE_LEFT_RULE)) continue
    const before = elementValue(spine, l.path)
    const after = parsed(l.proposal.new_text)
    if (before === undefined || after === undefined || after === null) continue
    const left = oldValuesLeft(before, after)
    if (!left.length) continue
    const message = oldValueLeftMessage(pathLabel(l.path), left)
    if (!l.manual && (l.redo_count ?? 0) < OLD_VALUE_BLOCK_ROUNDS) violations.set(l.location_id, [{ rule: OLD_VALUE_LEFT_RULE, message, path: l.path }])
    else flags.set(l.location_id, [{ rule: OLD_VALUE_LEFT_RULE, message }])
  }
  return { violations, flags }
}

export interface OldValueSweepHit {
  /** Phần tử còn ghi giá trị cũ (`functions[id=FN005]`). */
  path: string
  /** Giá trị cũ như viết ở đó. */
  values: string[]
  /** Nhãn chỗ còn sót ("Kiểm tra dữ liệu", "Mockup"). */
  places: string[]
}

/** Giá trị cũ của CR: mọi giá trị mà một đề xuất `edit` đã đổi ở ít nhất một đoạn chữ (dạng chuẩn hoá ⇒ cách viết thô). */
export const crReplacedValues = (locations: readonly Pick<IChangeLocation, "conclusion" | "proposal">[]): Map<string, string> => {
  const out = new Map<string, string>()
  for (const l of locations) {
    if (l.conclusion !== "edit") continue
    const before = parsed(l.proposal?.old_text)
    const after = parsed(l.proposal?.new_text)
    if (before === undefined || after === undefined) continue
    for (const [folded, raw] of replacedValues(before, after)) if (!out.has(folded)) out.set(folded, raw)
  }
  return out
}

/**
 * Lượt quét sau khi ghi CR: phần tử Spine (và chữ spec của mockup đã lưu) còn ghi giá trị mà CR vừa đổi. Bỏ phần tử C-3 đã kết
 * luận "không liên quan" (`skip`) và `source_ref`; ghi chú Brief / sổ quyết định không phải phần tử nên không bị quét.
 */
export const sweepOldValues = (spine: Spine, replaced: ReadonlyMap<string, string>, skip: ReadonlySet<string>): OldValueSweepHit[] => {
  if (!replaced.size) return []
  const wanted = new Set(replaced.keys())
  const hits = new Map<string, OldValueSweepHit>()
  const add = (path: string, found: { label: string; value: string }[]) => {
    if (!found.length || skip.has(path)) return
    const hit = hits.get(path) ?? { path, values: [], places: [] }
    for (const f of found) {
      if (!hit.values.includes(f.value)) hit.values.push(f.value)
      if (!hit.places.includes(f.label)) hit.places.push(f.label)
    }
    hits.set(path, hit)
  }
  for (const e of listElements(spine)) add(e.path, leavesWithValues(e.value, wanted))
  for (const d of spine.diagrams) {
    if (d.kind !== "screen_layout" || d.render_status !== "ok" || !d.owner_id) continue
    const spec = screenSpecOf(d.source)?.spec
    if (spec) add(`screens[id=${d.owner_id}]`, leavesWithValues(spec, wanted).map((f) => ({ ...f, label: "Bố cục màn hình" })))
  }
  return [...hits.values()]
}
