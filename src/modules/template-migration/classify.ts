/**
 * Phân nhóm kết quả ghép mục thành 4 nhóm (+ "đã sửa sau lần đổi mẫu" khi đổi ngược) — hàm thuần, không gọi AI.
 *
 *  - `matched`  : mục có cặp, cấu trúc bảng khớp ⇒ chép nguyên khối sang mẫu mới.
 *  - `missing`  : mục của mẫu đích chưa có cặp ⇒ thêm trống + hướng dẫn của mẫu (cờ đỏ chặn phát hành ở bước áp dụng).
 *  - `extra`    : mục của tài liệu hiện tại không có chỗ ở mẫu đích ⇒ BA chọn `keep_custom | move_to:<mục> | delete`.
 *  - `conflict` : có cặp nhưng không đặt thẳng được (bảng đổi cột, mục bị tách, bảng Record of Changes khác / mất) ⇒ BA chọn hoặc `ai_resolve`.
 *  - `edited_since`: chỉ đổi ngược — mục có Change ghi sau lần đổi mẫu, `keep` (mặc định) | `discard`.
 * Phần tử và phần nối không vào nhóm nào: đi theo mục cha (`PairingResult.followers`). Mỗi mục có cặp nằm ở đúng một trong
 * `matched` / `conflict`; mục đã sửa còn nằm thêm ở `edited_since`.
 */
import { isContentSection } from "../import/section-catalog.js"
import { targetsOf } from "../import/extract-targets.js"
import { overlapsOf } from "../import/content-slots.js"
import { recordColumnOfHeader } from "../import/legacy-record.js"
import { UNMAPPED_SECTION } from "../import/import.constants.js"
import { foldText } from "../import/text-similarity.js"
import type { EditedSection } from "./edited-since.js"
import { isFrameworkId, type NewHeading, type OldHeading, type PairBy, type PairingResult } from "./pair-sections.js"

export const RECORD_OF_CHANGES = "fixed:I"

/**
 * Lựa chọn cho mục **khung** (có dữ liệu có cấu trúc trong Spine: use case, bảng, yêu cầu…) mà mẫu đích không có chỗ: chỉ bỏ khỏi bản in, dữ
 * liệu + liên kết trong Spine giữ nguyên (hoàn tác / đổi ngược đưa lại). `delete` (xoá thật) chỉ dành cho mục riêng chữ tự do (`custom:*`).
 */
export const DROP_FROM_PRINT = "drop_from_print"

/** Mục riêng chữ tự do: không có dữ liệu có cấu trúc nên xoá thật được. */
export const isFreeTextSection = (sectionId: string): boolean => sectionId.startsWith("custom:") || sectionId === UNMAPPED_SECTION

/** Bảng của một mục: định danh từng cột (đường dẫn field nếu mapping biết, không thì chữ tiêu đề đã gập). */
export interface TableShape {
  columns: string[]
  /** Chữ tiêu đề từng cột như người đọc thấy (cùng thứ tự `columns`) — để so cột theo tên khi chỉ một phía có field và để hiện cho BA. */
  headers?: string[]
}

export type TableShapes = ReadonlyMap<string, readonly TableShape[]>

export interface MatchedItem {
  id: string
  old_key: string
  new_key: string
  by: PairBy
  needs_review: boolean
}

export interface MissingItem {
  id: string
  new_key: string
  heading_text: string
  section_id: string
  /** Mục có nội dung (không phải heading nhóm) ⇒ thêm trống + hướng dẫn, cờ đỏ chặn phát hành tới khi BA viết xong. */
  needs_content: boolean
  guidance: string | null
}

export interface ExtraItem {
  id: string
  old_key: string
  heading_text: string
  section_id: string
  /** Phần tử / phần nối đi theo mục này (đi cùng quyết định của nó). */
  follower_keys: string[]
  choices: string[]
  /** Lựa chọn cần AI sắp lại dữ liệu có cấu trúc (`move_to` vào mục trích được vào Spine). */
  ai_choices: string[]
  decision_required: true
}

export type ConflictKind = "table_columns" | "split_section" | "record_of_changes"

export interface ConflictItem {
  id: string
  kind: ConflictKind
  old_key: string
  /** `null` = mẫu đích không có mục tương ứng (Record of Changes mất). */
  new_key: string | null
  /** `split_section`: các heading của mẫu đích mà mục cũ có thể đặt vào. */
  candidate_keys: string[]
  old_columns: string[][]
  new_columns: string[][]
  choices: string[]
  ai_choices: string[]
  decision_required: true
}

export interface EditedItem {
  id: string
  old_key: string
  heading_text: string
  changes: number
  last_at: string
  /** Số ký tự đã sửa — ước tính credit dịch khi giữ. */
  chars: number
  choices: ["keep", "discard"]
  default: "keep"
}

export interface MigrationGroups {
  matched: MatchedItem[]
  missing: MissingItem[]
  extra: ExtraItem[]
  conflict: ConflictItem[]
  edited_since: EditedItem[]
  /** Heading nhóm không có nội dung riêng và không có chỗ ở mẫu đích — bỏ, không cần hỏi. */
  structure_only_dropped: string[]
  /** Đổi ngược: số mục có cặp chưa sửa từ lần đổi mẫu ⇒ tự lấy lại từ snapshot (không hỏi). `null` = đổi xuôi. */
  restored_from_snapshot: number | null
}

export interface ClassifyInput {
  old: readonly OldHeading[]
  neu: readonly NewHeading[]
  pairing: PairingResult
  oldTables?: TableShapes
  newTables?: TableShapes
  /** Đổi ngược: mục đã sửa sau `applied_at`, theo `old_key`. `null` / bỏ trống = đổi xuôi. */
  edited?: readonly EditedSection[] | null
}

const SAME_TABLE_CHOICES = ["map_by_header", "keep_old_table", "ai_resolve"]
const NO_TABLE_CHOICES = ["keep_old_table", "delete", "ai_resolve"]

/** Khoá theo chữ tiêu đề của cột `i` (không có `headers` thì suy từ định danh dạng `h:`); `null` = không biết. */
const headerKeyOf = (t: TableShape, i: number): string | null => {
  const header = t.headers?.[i]
  if (header !== undefined) return `h:${foldText(header)}`
  return t.columns[i].startsWith("h:") ? t.columns[i] : null
}

/**
 * Hai bảng cùng bộ cột (đổi thứ tự cột không tính là đổi). Hai cột là một khi cùng định danh, hoặc cùng chữ tiêu đề: mapping
 * của hai phía có thể chỉ một phía biết field (`use_cases[].id` so với `h:use case id`) mà cột vẫn là cùng một cột.
 */
export const sameColumns = (a: TableShape, b: TableShape): boolean => {
  if (a.columns.length !== b.columns.length) return false
  const free = new Set(b.columns.map((_, j) => j))
  for (let i = 0; i < a.columns.length; i++) {
    const hi = headerKeyOf(a, i)
    const hit = [...free].find((j) => a.columns[i] === b.columns[j] || (hi !== null && hi === headerKeyOf(b, j)))
    if (hit === undefined) return false
    free.delete(hit)
  }
  return true
}

/** Cột của bảng cho người đọc: chữ tiêu đề; bảng lưu từ trước (không có `headers`) thì bỏ tiền tố `h:` của định danh. */
const humanColumns = (t: TableShape): string[] => t.headers ?? t.columns.map((c) => (c.startsWith("h:") ? c.slice(2) : c))

/** Định danh cột: field của mapping nếu có; bảng Record of Changes theo cột lịch sử chuẩn; còn lại chữ tiêu đề. */
export const columnIdentity = (header: string, fieldPath: string | null | undefined, sectionId: string): string => {
  if (fieldPath) return fieldPath
  if (sectionId === RECORD_OF_CHANGES) {
    const col = recordColumnOfHeader(header)
    if (col) return `roc:${col}`
  }
  return `h:${foldText(header)}`
}

export interface TableSource {
  block_id: string
  section_id: string | null
  rows?: readonly (readonly string[])[] | null
}

/** Bảng theo mục (chỉ mục có `section_id`) — `fieldPaths` khoá `<block_id>#<cột>`. */
export const tableShapesBySection = (tables: readonly TableSource[], fieldPaths: ReadonlyMap<string, string | null>): Map<string, TableShape[]> => {
  const out = new Map<string, TableShape[]>()
  for (const t of tables) {
    const header = t.rows?.[0]
    if (!t.section_id || !header?.length) continue
    const shape: TableShape = { columns: header.map((h, c) => columnIdentity(h, fieldPaths.get(`${t.block_id}#${c}`), t.section_id!)), headers: header.map((h) => h.trim()) }
    out.set(t.section_id, [...(out.get(t.section_id) ?? []), shape])
  }
  return out
}

const isStructuredTarget = (sectionId: string): boolean => targetsOf(sectionId).length > 0

export const classify = (input: ClassifyInput): MigrationGroups => {
  const oldByKey = new Map(input.old.map((o) => [o.key, o]))
  const newByKey = new Map(input.neu.map((n) => [n.key, n]))
  const { pairing } = input
  const oldTables: TableShapes = input.oldTables ?? new Map<string, TableShape[]>()
  const newTables: TableShapes = input.newTables ?? new Map<string, TableShape[]>()
  const editedByKey = new Map((input.edited ?? []).map((e) => [e.key, e]))
  const splitByOld = new Map(pairing.split.map((s) => [s.old_key, s.new_keys]))

  const claimed = new Set<string>()
  for (const p of pairing.pairs) if (p.new_key) claimed.add(p.new_key)
  for (const s of pairing.split) for (const k of s.new_keys) claimed.add(k)
  const ignored = new Set(pairing.ignored_new)

  const followersOf = (key: string): string[] => pairing.followers.filter((f) => f.parent_old_key === key).map((f) => f.old_key)

  const missing: MissingItem[] = input.neu
    .filter((n) => !claimed.has(n.key) && !ignored.has(n.key))
    .map((n) => ({
      id: `x:${n.key}`,
      new_key: n.key,
      heading_text: n.heading_text,
      section_id: n.section_id,
      needs_content: n.section_id === UNMAPPED_SECTION || isContentSection(n.section_id),
      guidance: n.guidance ?? null
    }))

  // Mục thiếu có nội dung là nơi `move_to` đến được (mục đã có cặp không nhận thêm nội dung lạ)
  const moveTargets = missing.filter((m) => m.needs_content)
  const moveChoices = moveTargets.map((m) => `move_to:${m.new_key}`)
  const aiMoves = moveTargets.filter((m) => isStructuredTarget(m.section_id)).map((m) => `move_to:${m.new_key}`)

  const matched: MatchedItem[] = []
  const conflict: ConflictItem[] = []
  const extra: ExtraItem[] = []
  const edited_since: EditedItem[] = []
  const structure_only_dropped: string[] = []
  let restored = 0

  for (const p of pairing.pairs) {
    const o = oldByKey.get(p.old_key)
    if (!o) continue
    const nw = p.new_key ? newByKey.get(p.new_key) : undefined

    if (!nw) {
      if (o.section_id === RECORD_OF_CHANGES) {
        conflict.push({ id: `c:record_of_changes:${o.key}`, kind: "record_of_changes", old_key: o.key, new_key: null, candidate_keys: [], old_columns: (oldTables.get(o.section_id) ?? []).map(humanColumns), new_columns: [], choices: ["keep_custom", DROP_FROM_PRINT, "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true })
        continue
      }
      const followers = followersOf(o.key)
      // Heading nhóm không có phần nối / phần tử đi theo ⇒ chỉ là khung, không có gì để mất
      if (o.section_id.startsWith("group:") && !followers.length) {
        structure_only_dropped.push(o.key)
        continue
      }
      extra.push({ id: `e:${o.key}`, old_key: o.key, heading_text: o.heading_text, section_id: o.section_id, follower_keys: followers, choices: ["keep_custom", isFreeTextSection(o.section_id) ? "delete" : DROP_FROM_PRINT, ...moveChoices], ai_choices: aiMoves, decision_required: true })
      continue
    }

    const conflicts: ConflictItem[] = []
    if (isFrameworkId(o.section_id) && (o.section_id === nw.section_id || overlapsOf(o.section_id).includes(nw.section_id))) {
      const oldT = oldTables.get(o.section_id) ?? []
      const newT = newTables.get(nw.section_id) ?? []
      if (oldT.some((ot) => !newT.some((nt) => sameColumns(ot, nt)))) {
        const kind: ConflictKind = o.section_id === RECORD_OF_CHANGES ? "record_of_changes" : "table_columns"
        const choices = newT.length ? SAME_TABLE_CHOICES : NO_TABLE_CHOICES
        conflicts.push({ id: `c:${kind}:${o.key}`, kind, old_key: o.key, new_key: nw.key, candidate_keys: [], old_columns: oldT.map(humanColumns), new_columns: newT.map(humanColumns), choices, ai_choices: ["ai_resolve"], decision_required: true })
      }
    }
    const split = splitByOld.get(o.key)
    if (split && split.length > 1) {
      conflicts.push({ id: `c:split_section:${o.key}`, kind: "split_section", old_key: o.key, new_key: nw.key, candidate_keys: split, old_columns: [], new_columns: [], choices: [...split.map((k) => `to:${k}`), "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true })
    }
    conflict.push(...conflicts)

    const edit = editedByKey.get(o.key)
    if (edit) edited_since.push({ id: `s:${o.key}`, old_key: o.key, heading_text: o.heading_text, changes: edit.changes, last_at: edit.last_at, chars: edit.chars, choices: ["keep", "discard"], default: "keep" })
    else if (input.edited) restored++
    if (!conflicts.length && !edit) matched.push({ id: `m:${o.key}`, old_key: o.key, new_key: nw.key, by: p.by ?? "section_id", needs_review: p.needs_review })
  }

  return { matched, missing, extra, conflict, edited_since, structure_only_dropped, restored_from_snapshot: input.edited ? restored : null }
}

export interface DecidableItem {
  group: "extra" | "conflict" | "edited_since"
  choices: readonly string[]
  /** Lựa chọn cần AI (tính credit). */
  ai_choices: readonly string[]
  required: boolean
  default: string | null
}

/** Mọi mục nhận quyết định, theo id — nguồn kiểm "id có trong nhóm" + "lựa chọn đúng nhóm" ở PATCH decisions. */
export const decidableItems = (groups: MigrationGroups): Map<string, DecidableItem> => {
  const out = new Map<string, DecidableItem>()
  for (const e of groups.extra) out.set(e.id, { group: "extra", choices: e.choices, ai_choices: e.ai_choices, required: true, default: null })
  for (const c of groups.conflict) out.set(c.id, { group: "conflict", choices: c.choices, ai_choices: c.ai_choices, required: true, default: null })
  for (const s of groups.edited_since) out.set(s.id, { group: "edited_since", choices: s.choices, ai_choices: [], required: false, default: s.default })
  return out
}

export interface DecisionLike {
  id: string
  choice: string
}

/** Quyết định còn hiệu lực + mục bắt buộc chưa có quyết định. Quyết định không còn khớp nhóm mới bị bỏ. */
export const settleDecisions = <D extends DecisionLike>(groups: MigrationGroups, decisions: readonly D[]): { decisions: D[]; undecided: string[] } => {
  const items = decidableItems(groups)
  const kept = decisions.filter((d) => items.get(d.id)?.choices.includes(d.choice))
  const decided = new Set(kept.map((d) => d.id))
  return { decisions: kept, undecided: [...items].filter(([id, item]) => item.required && !decided.has(id)).map(([id]) => id) }
}
