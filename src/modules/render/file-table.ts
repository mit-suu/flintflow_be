/**
 * FLF-375: bảng của file upload giữ đúng cột của khách khi CR thêm / sửa / xoá phần tử.
 *
 * Bộ render dựng bảng phần tử theo cột mặc định của FlintFlow (vd use case: ID · Use Case · Actors · Use Case
 * Description · Includes · Extends). Với mục in nguyên văn file (FLF-366), bảng đó phải **khớp lại theo cột của bảng
 * trong file**: mỗi cột của file ↔ field Spine (từ điển tiêu đề `matchTable`) ↔ cột cùng field của bảng FlintFlow. Không
 * thêm cột vào bảng của khách; cột của file không có dữ liệu tương ứng ⇒ ô trống; cột số thứ tự ⇒ đánh số.
 * Phần tử thêm sau import ⇒ thành **dòng mới của bảng gốc cùng loại**, không thành bảng thứ hai.
 */

import { matchTable, TABLE_ENTITIES } from "../import/table-header-dictionary.js"
import { foldText } from "../import/text-similarity.js"
import type { Block, TableBlock, TableCell } from "./rendered-document.types.js"

const cellText = (cell: TableCell): string => cell.map((r) => r.text).join("").trim()
const tableRowsText = (t: TableBlock): string[][] => [t.header.map(cellText), ...t.rows.map((r) => r.map(cellText))]

interface FieldMap {
  entity: string
  /** field_path theo từng cột (null = cột không gán được field). */
  fields: (string | null)[]
}

/** Thực thể + field của từng cột; thử theo section trước, không ra thì đoán không theo section. */
export const tableFields = (rows: readonly string[][], sectionId: string | null): FieldMap | null => {
  for (const section of sectionId ? [sectionId, null] : [null]) {
    const m = matchTable(rows, section)
    if (m.entity) return { entity: m.entity, fields: m.columns.map((c) => c.field_path) }
  }
  return null
}

const norm = (s: string): string => foldText(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()

/**
 * Bảng của file thiếu cột bắt buộc để từ điển nhận loại (vd "# · Use case name · Actor · Description" không có cột mã)
 * ⇒ khớp tiêu đề theo đúng loại phần tử `entity` của bảng FlintFlow; cần ≥ 2 cột khớp mới nhận.
 */
const fieldsForEntity = (header: readonly string[], entity: string): FieldMap | null => {
  const def = TABLE_ENTITIES.find((d) => d.entity === entity)
  if (!def) return null
  const fields = header.map((h) => {
    const col = def.columns.find((c) => c.headers.some((alias) => norm(alias) === norm(h)))
    return col ? `${entity}[].${col.field}` : null
  })
  // Phải có cột định danh của đúng loại (mã / tên): "Actor · Description" của bảng tác nhân không phải bảng use case
  const identifies = def.required.some((f) => fields.includes(`${entity}[].${f}`))
  return identifies && fields.filter(Boolean).length >= 2 ? { entity, fields } : null
}

/** Bản đồ cột của bảng đích, ưu tiên cùng loại phần tử với bảng nguồn. */
const targetFields = (rows: readonly string[][], sectionId: string | null, entity: string): FieldMap | null => {
  const matched = tableFields(rows, sectionId)
  if (matched?.entity === entity) return matched
  return fieldsForEntity(rows[0] ?? [], entity)
}

const SEQUENCE_HEADER = /^(#|no\.?|stt|tt|số thứ tự|seq\.?)$/i

/** Cột số thứ tự của bảng (tiêu đề "#", "No", "STT"… và mọi ô thân là số). */
const sequenceColumns = (rows: readonly string[][]): Set<number> => {
  const [header = [], ...body] = rows
  return new Set(header.flatMap((h, j) => (SEQUENCE_HEADER.test(h.trim()) && body.every((r) => /^\d*$/.test((r[j] ?? "").trim())) ? [j] : [])))
}

/** Dòng của bảng FlintFlow `src` viết lại theo cột của bảng đích (header + bản đồ field + cột số thứ tự). */
const conformRows = (src: TableBlock, srcMap: FieldMap, header: readonly string[], target: FieldMap, sequence: Set<number>, firstNumber: number): TableCell[][] =>
  src.rows.map((row, k) =>
    header.map((_, j) => {
      if (sequence.has(j)) return [{ text: String(firstNumber + k) }]
      const field = target.fields[j]
      const i = field ? srcMap.fields.indexOf(field) : -1
      return i >= 0 ? (row[i] ?? []) : []
    })
  )

// ─── Ma trận phân quyền (hàng = màn, cột = vai trò) ────────────────────────────────────────────────

const MATRIX_FIRST = /^(screen|screens|man hinh|man|screen name|ten man hinh)$/

/** Hai bảng là ma trận màn × vai trò cùng kiểu: cột đầu là màn, có ít nhất một cột vai trò trùng tên. */
const isMatrixPair = (a: readonly string[], b: readonly string[]): boolean =>
  MATRIX_FIRST.test(norm(a[0] ?? "")) && MATRIX_FIRST.test(norm(b[0] ?? "")) && a.slice(1).some((h) => b.slice(1).some((x) => norm(x) === norm(h)))

const EMPTY_MARK = /^(|—|–|-|x?no|none|n\/a)$/i

/** Ký hiệu đánh dấu của file ("X", "✓"…) và ô trống của file ("" / "—") — lấy giá trị hay gặp nhất trong thân bảng. */
const marksOf = (body: readonly string[][]): { mark: string | null; empty: string } => {
  const count = (pick: (v: string) => boolean) => {
    const seen = new Map<string, number>()
    for (const r of body) for (const v of r.slice(1)) if (pick(v.trim())) seen.set(v.trim(), (seen.get(v.trim()) ?? 0) + 1)
    return [...seen.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
  }
  const mark = count((v) => !EMPTY_MARK.test(v)) ?? null
  // Ô có quyền trong file chỉ là một ký hiệu ngắn ⇒ quy về ký hiệu đó; dài (liệt kê hành động) ⇒ giữ chữ FlintFlow
  return { mark: mark && mark.length <= 3 ? mark : null, empty: count((v) => EMPTY_MARK.test(v)) ?? "" }
}

/** Dòng ma trận FlintFlow theo cột vai trò + ký hiệu của file. */
const matrixRow = (row: readonly TableCell[], srcHeader: readonly string[], header: readonly string[], marks: { mark: string | null; empty: string }): TableCell[] =>
  header.map((h, j) => {
    if (j === 0) return row[0] ?? []
    const i = srcHeader.findIndex((x, k) => k > 0 && norm(x) === norm(h))
    const value = i >= 0 ? cellText(row[i] ?? []) : ""
    return [{ text: EMPTY_MARK.test(value) ? marks.empty : (marks.mark ?? value) }]
  })

/**
 * Ghép quyền **thêm mới** (`src`: ma trận chỉ chứa quyền mới, mọi màn) vào ma trận `t` của file: chỉ bật thêm ô có quyền,
 * không xoá ô sẵn có; màn chưa có dòng ⇒ dòng mới; dòng không có quyền nào ⇒ bỏ qua.
 */
const mergeMatrix = (t: TableBlock, src: TableBlock): TableBlock => {
  const text = tableRowsText(t)
  const srcHeader = src.header.map(cellText)
  const marks = marksOf(text.slice(1))
  const rows = [...t.rows]
  for (const r of src.rows) {
    const next = matrixRow(r, srcHeader, text[0], marks)
    const granted = next.slice(1).some((c) => cellText(c) !== marks.empty)
    if (!granted) continue
    const at = rows.findIndex((x) => norm(cellText(x[0] ?? [])) === norm(cellText(r[0] ?? [])))
    if (at < 0) rows.push(next)
    else rows[at] = rows[at].map((cell, j) => (j > 0 && cellText(next[j] ?? []) !== marks.empty ? next[j] : cell))
  }
  return { ...t, rows }
}

/**
 * Bảng FlintFlow dựng lại cho một đoạn mà file có bảng `fileRows` (header + body nguyên văn) ⇒ bảng mang header của
 * file, dòng theo cột của file (đánh số lại từ 1). Không cùng loại phần tử ⇒ giữ nguyên.
 */
export const conformToFileTable = (block: TableBlock, fileRows: readonly string[][], sectionId: string | null): TableBlock => {
  if (!fileRows.length) return block
  if (isMatrixPair(fileRows[0], block.header.map(cellText))) {
    const header: TableCell[] = fileRows[0].map((h) => [{ text: h, bold: true }])
    return { type: "table", header, rows: block.rows.map((r) => matrixRow(r, block.header.map(cellText), fileRows[0], marksOf(fileRows.slice(1)))) }
  }
  const src = tableFields(tableRowsText(block), sectionId)
  const target = src ? targetFields(fileRows, sectionId, src.entity) : null
  if (!target || !src) return block
  const header: TableCell[] = fileRows[0].map((h) => [{ text: h, bold: true }])
  return { type: "table", header, rows: conformRows(block, src, fileRows[0], target, sequenceColumns(fileRows), 1) }
}

/** Mọi bảng trong `blocks` khớp lại theo bảng của file (cùng loại phần tử); khối khác giữ nguyên. */
export const conformBlocksToFileTable = (blocks: Block[], fileRows: readonly string[][] | undefined, sectionId: string | null): Block[] =>
  fileRows?.length ? blocks.map((b) => (b.type === "table" ? conformToFileTable(b, fileRows, sectionId) : b)) : blocks

/**
 * Phần tử thêm sau import (`extra`, đã dựng thành bảng FlintFlow) ⇒ dòng mới của bảng **cuối cùng cùng loại phần tử**
 * đã in trong `out` (bảng nguyên văn của file hoặc bảng đã khớp cột). Sửa `out` tại chỗ; trả các khối không ghép được.
 */
export const appendToFileTables = (out: Block[], extra: readonly Block[], sectionId: string | null): Block[] => {
  const left: Block[] = []
  for (const b of extra) {
    let merged = false
    if (b.type === "table") {
      const header = b.header.map(cellText)
      let at = out.length - 1
      while (at >= 0 && !(out[at].type === "table" && isMatrixPair((out[at] as TableBlock).header.map(cellText), header))) at--
      if (at >= 0) {
        out[at] = mergeMatrix(out[at] as TableBlock, b)
        continue
      }
    }
    const src = b.type === "table" ? tableFields(tableRowsText(b), sectionId) : null
    for (let i = out.length - 1; b.type === "table" && src && i >= 0; i--) {
      const t = out[i]
      if (t.type !== "table") continue
      const text = tableRowsText(t)
      const target = targetFields(text, sectionId, src.entity)
      if (!target) continue
      out[i] = { ...t, rows: [...t.rows, ...conformRows(b, src, text[0], target, sequenceColumns(text), t.rows.length + 1)] }
      merged = true
      break
    }
    if (!merged) left.push(b)
  }
  return left
}
