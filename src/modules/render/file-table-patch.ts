/**
 * file-table-patch.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-468 (lát B): bảng của file upload (mục đã import) giữ đúng cột **và đúng hàng** khi CR sửa / thêm / xoá phần tử,
 * thay vì dựng lại cả bảng từ Spine (`layout-sections.ts` `rebuildMarked` cũ) — dựng lại làm mất mọi thứ Spine không
 * giữ (dấu X của ma trận, cột "Feature" không có field, bố cục…) và sinh "bảng thứ hai" khi ghép cột thất bại.
 *
 * Hàm thuần — không đọc DB, không biết Spine. Nhận vào bảng nguyên văn của file (`CustomBlock.rows`: hàng 0 là tiêu
 * đề), cột ⇒ field đã ghép (ưu tiên `table_map`, rồi từ điển `tableFields`), và phần tử hiện tại của Spine đã được bên
 * gọi (`layout-sections.ts`) rút sẵn thành chuỗi hiển thị theo field — tránh module này phải biết cách Spine tham
 * chiếu actor / use case / vai trò (việc đó `section-renderer.ts` đã làm khi dựng bảng FlintFlow).
 *
 * Ghép hàng ↔ phần tử theo cột "mã" (ưu tiên field `code`, rồi `id`, không có thì theo cột `name`): hàng khớp được
 * phần tử hiện tại ⇒ chỉ ghi lại ô có field (ô không có field — "Feature", ghi chú riêng của khách — giữ nguyên văn),
 * ô giữ nguyên nếu chữ không đổi; hàng không khớp phần tử nào ⇒ phần tử đã bị CR xoá, bỏ hàng. Phần tử không khớp
 * được hàng nào ⇒ phần tử mới của CR, thêm hàng cuối bảng theo đúng cột của file.
 */

import type { TableMapEntry } from "../import/template-profile.model.js"
import { tableFields } from "./file-table.js"

export interface FileTableColumns {
  /** Thực thể Spine của bảng (`messages`, `business_rules`…). */
  entity: string
  /** field (không có tiền tố thực thể, vd `code`) theo từng cột của file; `null` = cột không có field tương ứng. */
  fields: readonly (string | null)[]
}

/**
 * Cột ⇒ field của bảng file, ưu tiên `table_map` của hồ sơ mẫu (ghi lúc import/xác nhận mapping — như writer
 * `projectMappedTable`), không có thì tới từ điển tiêu đề (`tableFields`, dùng cho bản ghi import trước khi từ điển
 * có thực thể này). Không ghép được ⇒ `null` (không vá được bảng).
 */
export const resolveFileTableColumns = (
  fileRows: readonly string[][],
  sectionId: string | null,
  blockId: string | null,
  tableMap: readonly TableMapEntry[]
): FileTableColumns | null => {
  const header = fileRows[0] ?? []
  const mapped = blockId ? tableMap.filter((m) => m.block_id === blockId) : []
  const entity = mapped.map((m) => m.field_path?.split("[].")[0]).find((e): e is string => !!e)
  if (entity) return { entity, fields: header.map((_, i) => mapped.find((m) => m.column_index === i)?.field_path?.split("[].")[1] ?? null) }
  const byDictionary = tableFields(fileRows, sectionId)
  return byDictionary ? { entity: byDictionary.entity, fields: byDictionary.fields.map((f) => f?.split("[].")[1] ?? null) } : null
}

/** Field ưu tiên để ghép hàng ↔ phần tử ("mã" của phần tử): `code` trước, không có thì `id`, không có thì `name`. */
const MATCH_FIELD_PRIORITY = ["code", "id", "name"] as const

/** Cột của file dùng để ghép hàng ↔ phần tử theo `fields` đã ghép; không có cột mã / tên nào ⇒ `null`. */
export const matchColumnOf = (columns: FileTableColumns): number | null => {
  for (const field of MATCH_FIELD_PRIORITY) {
    const at = columns.fields.indexOf(field)
    if (at >= 0) return at
  }
  return null
}

/** Cột số thứ tự của file ("#", "STT"…) — nhận theo `role_id` không áp; đây nhận theo field `null` + tiêu đề ở ngoài. */
const SEQUENCE_HEADER = /^(#|no\.?|stt|tt|số thứ tự|seq\.?)$/i

/** Cột số thứ tự: tiêu đề khớp mẫu và mọi ô thân hiện là số (hoặc trống) — đánh lại liên tục sau khi vá. */
export const sequenceColumnOf = (header: readonly string[], body: readonly string[][]): number | null => {
  const at = header.findIndex((h) => SEQUENCE_HEADER.test(h.trim()))
  return at >= 0 && body.every((r) => /^\d*$/.test((r[at] ?? "").trim())) ? at : null
}

const norm = (s: string): string => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()

export interface PatchElement {
  /** Chuỗi hiển thị dùng để ghép hàng (giá trị field mã/tên hiện tại của phần tử). */
  matchValue: string
  /** field (không tiền tố thực thể) ⇒ chuỗi hiển thị hiện tại — chỉ cần các field mà `columns.fields` có dùng. */
  fields: Readonly<Record<string, string>>
}

export interface PatchFileTableInput {
  /** Hàng tiêu đề (0) + thân của bảng file, nguyên văn (`CustomBlock.rows`). */
  fileRows: readonly string[][]
  /** Cột ⇒ field (song song `fileRows[0]`); `null` = không ghép được cột nào (bảng không vá được). */
  columns: FileTableColumns | null
  /** Phần tử hiện tại của Spine (còn tồn tại) thuộc đúng thực thể của bảng. */
  current: readonly PatchElement[]
}

export interface PatchFileTableResult {
  /** Hàng tiêu đề + thân đã vá, theo đúng cột của file. */
  rows: string[][]
  /**
   * `true`: không vá được (không có cột mã/tên để ghép hàng, hoặc không ghép được field nào) — bên gọi giữ bảng
   * nguyên văn + cờ vàng ("Cần chốt" #2) thay vì dùng `rows` ở đây.
   */
  unmatched: boolean
}

/** Không vá được: trả lại nguyên bảng file, đánh dấu `unmatched`. */
const keepAsIs = (fileRows: readonly string[][]): PatchFileTableResult => ({ rows: fileRows.map((r) => [...r]), unmatched: true })

/**
 * Vá bảng của file theo hàng (FLF-468 lát B). `fileRows` là bảng **nguyên văn lúc import** (không đổi theo lần gọi) —
 * hàm thuần, không phụ thuộc thứ tự gọi.
 */
export const patchFileTableRows = (input: PatchFileTableInput): PatchFileTableResult => {
  const { fileRows, columns, current } = input
  const [header, ...body] = fileRows
  if (!columns || !header?.length) return keepAsIs(fileRows)
  const matchColumn = matchColumnOf(columns)
  if (matchColumn === null) return keepAsIs(fileRows)
  const sequenceColumn = sequenceColumnOf(header, body)
  const usedCurrent = new Set<number>()
  const findCurrent = (value: string): number =>
    current.findIndex((el, i) => !usedCurrent.has(i) && value && norm(el.matchValue) === norm(value))

  const keptRows: string[][] = []
  for (const row of body) {
    const value = (row[matchColumn] ?? "").trim()
    const at = findCurrent(value)
    // Không khớp phần tử hiện tại nào: cột mã đã xác định đáng tin (≥ 2 field khớp từ điển / table_map) ⇒ phần tử của
    // hàng này đã bị CR xoá khỏi Spine — bỏ hàng, không trải nguyên văn vì mục đã có vá (không phải trường hợp #2).
    if (at < 0) continue
    usedCurrent.add(at)
    const el = current[at]
    keptRows.push(row.map((cell, col) => {
      const field = columns.fields[col]
      if (!field) return cell // cột không có field tương ứng — giữ nguyên văn (vd "Feature" của bảng màn)
      const current = el.fields[field]
      return current !== undefined && current !== cell ? current : cell
    }))
  }
  // Phần tử mới (CR thêm, không khớp hàng nào) ⇒ thêm hàng cuối theo đúng cột của file
  const newRows = current
    .map((el, i) => ({ el, i }))
    .filter(({ i }) => !usedCurrent.has(i))
    .map(({ el }) => header.map((_, col) => {
      const field = columns.fields[col]
      return field ? (el.fields[field] ?? "") : ""
    }))
  const rows = [...keptRows, ...newRows]
  if (sequenceColumn !== null) rows.forEach((row, i) => { row[sequenceColumn] = String(i + 1) })
  return { rows: [header, ...rows], unmatched: false }
}

// ─── Ma trận phân quyền (hàng = màn, cột = vai trò) ────────────────

const EMPTY_MARK = /^(|—|–|-|x?no|none|n\/a)$/i

/** Ký hiệu đánh dấu của file ("X", "✓"…) và ô trống của file — lấy giá trị hay gặp nhất trong thân bảng. */
const marksOf = (body: readonly string[][]): { mark: string; empty: string } => {
  const count = (pick: (v: string) => boolean) => {
    const seen = new Map<string, number>()
    for (const r of body) for (const v of r.slice(1)) if (pick(v.trim())) seen.set(v.trim(), (seen.get(v.trim()) ?? 0) + 1)
    return [...seen.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
  }
  return { mark: count((v) => !EMPTY_MARK.test(v)) ?? "X", empty: count((v) => EMPTY_MARK.test(v)) ?? "" }
}

export interface PatchMatrixInput {
  /** Hàng tiêu đề (cột 0 = màn hình, cột sau = tên vai trò) + thân, nguyên văn lúc import. */
  fileRows: readonly string[][]
  /** Màn hình hiện tại của Spine: tên hiển thị ⇒ tập vai trò hiện có quyền (tên vai trò, khớp không phân biệt hoa thường/dấu). */
  current: ReadonlyMap<string, ReadonlySet<string>>
}

export interface PatchMatrixResult {
  rows: string[][]
}

/**
 * Vá ma trận phân quyền theo **hiệu quyền** so với file: chỉ bật / tắt đúng ô có quyền thêm / bỏ, giữ ký hiệu gốc của
 * file ở ô không đổi (không thay cả ma trận bằng ký hiệu FlintFlow). Màn đã xoá khỏi Spine ⇒ bỏ hàng; màn mới ⇒ thêm
 * hàng cuối (mọi vai trò hiện có quyền được đánh dấu).
 */
export const patchPermissionMatrix = (input: PatchMatrixInput): PatchMatrixResult => {
  const { fileRows, current } = input
  const [header, ...body] = fileRows
  if (!header?.length) return { rows: fileRows.map((r) => [...r]) }
  const roles = header.slice(1)
  const { mark, empty } = marksOf(body)
  const grantOf = (screenName: string): ReadonlySet<string> | undefined => {
    for (const [name, set] of current) if (norm(name) === norm(screenName)) return set
    return undefined
  }
  const usedScreens = new Set<string>()
  const keptRows: string[][] = []
  for (const row of body) {
    const screenName = (row[0] ?? "").trim()
    const grants = grantOf(screenName)
    if (!grants) continue // màn đã bị xoá khỏi Spine ⇒ bỏ hàng
    usedScreens.add(norm(screenName))
    keptRows.push([row[0] ?? "", ...roles.map((role) => (grants.has(role.trim()) ? mark : empty))])
  }
  for (const [screenName, grants] of current) {
    if (usedScreens.has(norm(screenName))) continue
    keptRows.push([screenName, ...roles.map((role) => (grants.has(role.trim()) ? mark : empty))])
  }
  return { rows: [header, ...keptRows] }
}
