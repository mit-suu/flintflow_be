/**
 * FLF-361 — nguyên văn mục chức năng của file import (FLF-252), CR chỉ sửa đúng **phần tử** đã đổi. Hàm thuần.
 *
 * Lúc import, mỗi khối của mục được đối chiếu **theo chữ** với giá trị từng trường của chức năng (từng bước luồng chính /
 * lỗi, từng validation, trigger, mô tả…): khối chứa giá trị nào thì ghi `tags` (trường + vị trí phần tử). Giá trị lúc import
 * lưu ở `field_values`. CR sửa chức năng ⇒ so từng phần tử cũ / mới:
 * - phần tử sửa ⇒ thay đúng đoạn chữ đó trong khối (nhãn đầu dòng "Business rules: …" giữ nguyên);
 * - phần tử xoá ⇒ bỏ khối (hoặc bỏ đoạn chữ đó nếu khối còn chữ khác);
 * - phần tử thêm ⇒ chèn ngay sau phần tử đứng trước nó, cùng kiểu khối.
 * Khối không chứa giá trị đổi (Navigation path, Interface, nhãn, ảnh Screen layout…) giữ nguyên văn.
 *
 * Không tin danh sách khối nguồn model trích ghi: model ghi cùng một danh sách cho cả chức năng (mọi khối mang mọi trường).
 * Dữ liệu nằm ở `TemplateProfile.function_originals` (Mixed) — không thêm trường vào Spine.
 */

import type { CustomBlock, Spine } from "../spine/spine.types.js"

type Fn = Spine["functions"][number]

/** Heading con trong mục chức năng ("Function trigger", "Screen layout"…) — `level` tương đối heading của mục (≥ 1). */
export interface FunctionHeadingBlock {
  kind: "heading"
  text: string
  level: number
}

/**
 * Khối chứa phần tử thứ `index` của trường `field` (theo giá trị lúc import). `part`: chỉ một đoạn của giá trị — model
 * ghép nhiều dòng của file vào một trường ("Navigation path: Login" + "Timing frequency: …" ⇒ trigger "Login; …").
 */
export interface FieldTag {
  field: FunctionTextField
  index: number
  part?: number
}

/** Khối nguyên văn của mục chức năng; `tags` = phần tử chức năng có chữ nằm trong khối này. */
export type FunctionOriginalBlock = (CustomBlock | FunctionHeadingBlock) & { tags?: FieldTag[] }

/** Trường có chữ in trong mục chức năng (tên ở tiêu đề mục; màn / ưu tiên không có dòng riêng). */
export const FUNCTION_TEXT_FIELDS = ["trigger", "description", "normal", "abnormal", "validations", "business_rule_ids"] as const
export type FunctionTextField = (typeof FUNCTION_TEXT_FIELDS)[number]

export type FunctionFieldValues = Record<FunctionTextField, string[]>

/** Chữ của từng trường (business rule ⇒ câu quy tắc, như người đọc thấy trong mục). */
export const functionFieldValues = (spine: Pick<Spine, "business_rules">, fn: Fn): FunctionFieldValues => {
  const clean = (xs: readonly string[]) => xs.map((x) => x.trim()).filter(Boolean)
  return {
    trigger: clean([fn.trigger ?? ""]),
    description: clean([fn.description ?? ""]),
    normal: clean(fn.normal ?? []),
    abnormal: clean(fn.abnormal ?? []),
    validations: clean((fn.validations ?? []).map((v) => v.statement)),
    business_rule_ids: clean((fn.business_rule_ids ?? []).flatMap((id) => spine.business_rules.find((r) => r.id === id)?.statement ?? []))
  }
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim()
/** Giá trị ngắn hơn chừng này chỉ khớp khi bằng cả khối (tránh "Login" khớp nhầm vào mọi câu). */
const MIN_CONTAINED = 12

const textOf = (b: FunctionOriginalBlock): string | null => (b.kind === "paragraph" || b.kind === "list_item" ? b.text : null)

/** Dấu ghép các đoạn của một giá trị (mergeFieldValue của import). */
const PART_SEPARATOR = "; "
const partsOf = (v: string): string[] => v.split(PART_SEPARATOR)

/** Khối chứa chữ `v`: bằng cả khối, bằng phần sau nhãn đầu dòng ("Validation: N/A"), hoặc nằm trong khối (chữ đủ dài). */
const holds = (blockText: string, value: string): boolean => {
  // không phân biệt hoa thường: model trích viết hoa đầu câu ("The system scans…") phần nằm giữa câu của file ("…2:00 AM the system scans…")
  const t = norm(blockText).toLowerCase()
  const v = norm(value).toLowerCase()
  if (!v) return false
  if (t === v || (v.length >= MIN_CONTAINED && t.includes(v))) return true
  const label = /^[^:\n]{1,40}:\s*(.*)$/.exec(t)
  return !!label && norm(label[1]) === v
}

/** Gắn `tags` cho khối theo chữ: khối chứa giá trị (hoặc một đoạn của giá trị ghép) của trường. Gọi lúc import. */
export const tagFunctionBlocks = (blocks: readonly FunctionOriginalBlock[], values: FunctionFieldValues): FunctionOriginalBlock[] => {
  const tags = blocks.map(() => [] as FieldTag[])
  for (const field of FUNCTION_TEXT_FIELDS) {
    values[field].forEach((raw, index) => {
      const whole = blocks.map((b, i) => (textOf(b) !== null && holds(textOf(b)!, raw) ? i : -1)).filter((i) => i >= 0)
      if (whole.length) return whole.forEach((i) => tags[i].push({ field, index }))
      // Giá trị ghép từ nhiều dòng: mỗi đoạn phải nằm ở một khối, không thì không gắn (sửa tại chỗ không được)
      const parts = partsOf(raw)
      if (parts.length < 2) return
      const at = parts.map((part) => blocks.findIndex((b) => textOf(b) !== null && holds(textOf(b)!, part)))
      if (at.every((i) => i >= 0)) at.forEach((i, part) => tags[i].push({ field, index, part }))
    })
  }
  return blocks.map((b, i) => {
    const { tags: _old, ...rest } = b
    return (tags[i].length ? { ...rest, tags: tags[i] } : rest) as FunctionOriginalBlock
  })
}

export const changedFunctionFields = (before: FunctionFieldValues, after: FunctionFieldValues): Set<FunctionTextField> =>
  new Set(FUNCTION_TEXT_FIELDS.filter((f) => JSON.stringify(before[f] ?? []) !== JSON.stringify(after[f] ?? [])))

/** So phần tử cũ / mới: giữ (LCS), sửa (cặp xoá + thêm cùng khoảng), xoá, thêm (sau phần tử cũ thứ `after`, -1 = đầu). */
interface FieldDiff {
  replaced: Map<number, string | null>
  inserts: { after: number; value: string }[]
}

const diffValues = (old: readonly string[], next: readonly string[]): FieldDiff => {
  const n = old.length
  const m = next.length
  const same = (i: number, j: number) => norm(old[i]) === norm(next[j])
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = same(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const replaced = new Map<number, string | null>()
  const inserts: FieldDiff["inserts"] = []
  let lastKept = -1
  let gapOld: number[] = []
  let gapNew: string[] = []
  // Một khoảng giữa hai phần tử giữ nguyên: cặp xoá + thêm theo thứ tự là "sửa", phần dư là xoá / thêm
  const flush = () => {
    const pairs = Math.min(gapOld.length, gapNew.length)
    for (let k = 0; k < pairs; k++) replaced.set(gapOld[k], gapNew[k])
    for (let k = pairs; k < gapOld.length; k++) replaced.set(gapOld[k], null)
    const after = pairs > 0 ? gapOld[pairs - 1] : lastKept
    for (let k = pairs; k < gapNew.length; k++) inserts.push({ after, value: gapNew[k] })
    gapOld = []
    gapNew = []
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && same(i, j)) {
      flush()
      lastKept = i++
      j++
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) gapNew.push(next[j++])
    else gapOld.push(i++)
  }
  flush()
  return { replaced, inserts }
}

/** Nhãn khi trường đã đổi không có khối nào trong file (CR thêm luồng lỗi cho chức năng file không ghi). */
const FIELD_LABEL: Readonly<Record<FunctionTextField, string>> = {
  trigger: "Function trigger",
  description: "Function description",
  normal: "Normal case",
  abnormal: "Abnormal case",
  validations: "Validation",
  business_rule_ids: "Business rules"
}
const SCALAR = new Set<FunctionTextField>(["trigger", "description"])
/** Phần còn lại của khối sau khi bỏ chữ phần tử chỉ là nhãn / dấu câu ⇒ bỏ cả khối. */
const ONLY_LABEL = /^[^\p{L}\p{N}]*([^:]{0,40}:)?[^\p{L}\p{N}]*$/u

/** Thay chữ cũ bằng chữ mới trong khối: khớp nguyên chữ, không thì phần sau nhãn đầu dòng ("Validation: N/A"). */
const replaceIn = (text: string, old: string, to: string): string => {
  if (text.includes(old)) return text.split(old).join(to)
  if (norm(text).toLowerCase() === norm(old).toLowerCase()) return to
  const at = text.toLowerCase().indexOf(old.toLowerCase())
  if (old && at >= 0) {
    // giữa câu của file ⇒ giữ chữ thường đầu như file
    const fit = /[a-z]/.test(text[at] ?? "") ? to.charAt(0).toLowerCase() + to.slice(1) : to
    return text.slice(0, at) + fit + text.slice(at + old.length)
  }
  const label = /^([^:\n]{1,40}:\s*)(.*)$/s.exec(text)
  return label && norm(label[2]).toLowerCase() === norm(old).toLowerCase() ? `${label[1]}${to}` : text
}

const block = (kind: "paragraph" | "list_item", text: string): FunctionOriginalBlock => ({ kind, text, rows: null, image_ref: null })

/**
 * Khối in của mục chức năng đã bị CR sửa (xem đầu file). Trường đã đổi **có chữ lúc import** mà không khối nào chứa ⇒
 * `null` (không sửa tại chỗ được — giữ khối cũ là in chữ cũ; người gọi dựng lại cả mục).
 */
export const patchFunctionOriginal = (blocks: readonly FunctionOriginalBlock[], before: FunctionFieldValues, after: FunctionFieldValues): FunctionOriginalBlock[] | null => {
  const changed = changedFunctionFields(before, after)
  const tagged = (f: FunctionTextField, index?: number) => blocks.some((b) => b.tags?.some((t) => t.field === f && (index === undefined || t.index === index)))
  const diffs = new Map([...changed].map((f) => [f, diffValues(before[f] ?? [], after[f] ?? [])]))
  for (const f of changed) {
    if (!(before[f] ?? []).length) continue
    if (!tagged(f)) return null
    // phần tử sửa / xoá mà không khối nào chứa chữ của nó ⇒ không sửa tại chỗ được (giữ là in chữ cũ)
    for (const [index, to] of diffs.get(f)!.replaced) {
      if (!tagged(f, index)) return null
      // giá trị ghép từ nhiều dòng: chỉ sửa tại chỗ khi giá trị mới cùng số đoạn
      const split = blocks.some((b) => b.tags?.some((t) => t.field === f && t.index === index && t.part !== undefined))
      if (split && (to === null || partsOf(to).length !== partsOf(before[f][index]).length)) return null
    }
  }

  // Chỗ chèn phần tử mới: trong nhóm khối liền nhau chứa trường đó dài nhất (danh sách chính, không phải bản lặp lại
  // như "Data processing" chép các bước hệ thống của luồng chính) — sau khối của phần tử đứng trước, không có thì cuối nhóm
  const insertAfter = new Map<number, FunctionOriginalBlock[]>()
  const insertBefore = new Map<number, FunctionOriginalBlock[]>()
  for (const f of changed) {
    let best: number[] = []
    let cur: number[] = []
    blocks.forEach((b, i) => {
      if (b.tags?.some((t) => t.field === f)) cur.push(i)
      else if (b.kind !== "heading" && textOf(b) !== null && cur.length) {
        if (cur.length > best.length) best = cur
        cur = []
      }
    })
    if (cur.length > best.length) best = cur
    if (!best.length) continue
    const kind = blocks[best[0]].kind === "list_item" ? "list_item" : "paragraph"
    for (const ins of diffs.get(f)!.inserts) {
      const at = best.find((i) => blocks[i].tags?.some((t) => t.field === f && t.index === ins.after))
      const target = ins.after === -1 ? insertBefore : insertAfter
      const pos = ins.after === -1 ? best[0] : at ?? best[best.length - 1]
      target.set(pos, [...(target.get(pos) ?? []), block(kind, ins.value)])
    }
  }

  const out: FunctionOriginalBlock[] = []
  blocks.forEach((b, i) => {
    out.push(...(insertBefore.get(i) ?? []))
    const tags = (b.tags ?? []).filter((t) => changed.has(t.field))
    const text = textOf(b)
    if (!tags.length || text === null) out.push(b)
    else {
      let next = text
      for (const t of tags) {
        const whole = before[t.field][t.index]
        const toWhole = diffs.get(t.field)?.replaced.get(t.index)
        if (toWhole === undefined || !whole) continue
        const old = t.part === undefined ? whole : partsOf(whole)[t.part]
        const to = toWhole === null ? null : t.part === undefined ? toWhole : partsOf(toWhole)[t.part]
        next = replaceIn(next, old, to ?? "")
      }
      // khối chỉ còn nhãn ⇒ phần tử đã xoá: bỏ khối (nhãn riêng dòng của file — "Abnormal case:" — là khối khác, vẫn giữ)
      if (next === text) out.push(b)
      else if (!ONLY_LABEL.test(next.trim())) out.push({ ...b, text: next.replace(/[ \t]{2,}/g, " ").trim() } as FunctionOriginalBlock)
    }
    out.push(...(insertAfter.get(i) ?? []))
  })
  // Trường file không ghi mà CR thêm ⇒ cuối mục, có nhãn
  for (const f of changed) {
    if (tagged(f)) continue
    const values = after[f] ?? []
    if (values.length) out.push(block("paragraph", FIELD_LABEL[f]), ...values.map((v) => block(SCALAR.has(f) ? "paragraph" : "list_item", v)))
  }
  return out
}
