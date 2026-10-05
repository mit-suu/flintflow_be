/**
 * Record of Changes của file gốc (nợ T15, mode 1 v3): mục `fixed:I` là mục tự sinh từ lịch sử thay đổi của FlintFlow,
 * nên trước đây bảng lịch sử sửa đổi **của khách** trong file upload bị thay mất. Import đọc lại bảng đó (khối bảng nằm
 * dưới heading khớp `fixed:I`) thành các dòng `RocRow`; render in các dòng cũ lên đầu bảng, lịch sử FlintFlow nối tiếp.
 * FLF-252: đọc theo hình dạng bảng (hàng tiêu đề thật, cột nhận theo cả dữ liệu — ngày, phiên bản, A/M/D), bỏ dòng chú
 * thích "*A - Added…"; file không có heading "Record of Changes" ⇒ nhận bảng theo bộ cột đặc trưng trước mục nội dung đầu.
 * Hàm thuần — không DB.
 */

import type { RocChangeType, RocRow } from "../render/rendered-document.types.js"
import { tableShape, type ColumnRole } from "./table-shape.js"

export interface RecordSourceBlock {
  block_id: string
  kind: string
  level: number | null
  rows?: string[][] | null
}

const RECORD_SECTION = "fixed:I"

type Column = keyof RocRow | "item"

/** Nhận cột theo chữ tiêu đề (mẫu FPT / IEEE tiếng Anh + tiếng Việt). Thứ tự quan trọng: "Change Item" trước "Change Description". */
const COLUMN_PATTERNS: [Column, RegExp][] = [
  ["date", /\b(date|ngày)\b/i],
  ["version", /\b(version|phiên bản|ver|rev(ision)?)\b/i],
  ["change_type", /(a\*|a,\s*m|\bm,\s*d|\btype\b|\bloại\b)/i],
  ["in_charge", /(in charge|người|author|thực hiện|phụ trách|changed by|editor)/i],
  ["item", /(change item|\bitem\b|hạng mục|mục thay đổi|section)/i],
  ["description", /(description|mô tả|nội dung|change|summary|ghi chú)/i]
]

const columnOf = (header: string): Column | null => {
  for (const [column, pattern] of COLUMN_PATTERNS) if (pattern.test(header)) return column
  return null
}

/** Vai trò dữ liệu ⇒ cột khi tiêu đề không nói được (cột "#" chứa ngày, cột không tên chứa A/M/D…). */
const BY_ROLE: Partial<Record<ColumnRole, Column>> = { date: "date", version: "version", change_type: "change_type" }

const changeType = (raw: string): RocChangeType => {
  const v = raw.trim().toUpperCase()
  return v.startsWith("A") || v.startsWith("TH") ? "A" : v.startsWith("D") || v.startsWith("X") ? "D" : "M"
}

/** Dòng chú thích loại thay đổi dưới/trong bảng: "*A - Added, M - Modified, D - Deleted". */
const LEGEND = /^\*?\s*a\s*[-–:=]\s*(added|thêm)/i

/** Cột của bảng lịch sử: theo tiêu đề, rồi theo dữ liệu cho cột tiêu đề không nhận ra. */
const recordColumns = (rows: readonly string[][]): { shape: ReturnType<typeof tableShape>; columns: (Column | null)[] } => {
  const shape = tableShape(rows)
  const columns = shape.headers.map((h) => columnOf(h))
  shape.columns.forEach((c, i) => {
    const byData = BY_ROLE[c.role]
    if (!columns[i] && byData && !columns.includes(byData)) columns[i] = byData
  })
  return { shape, columns }
}

/** Bảng trông như bảng lịch sử thay đổi: có cột mô tả và ít nhất một trong ngày / phiên bản / loại thay đổi. */
export const looksLikeRecordTable = (rows: readonly string[][]): boolean => {
  if (!rows.length) return false
  const { columns } = recordColumns(rows)
  return columns.includes("description") && (columns.includes("date") || columns.includes("version") || columns.includes("change_type"))
}

/** Một bảng Record of Changes ⇒ các dòng; bảng không có cột mô tả nhận ra được ⇒ không phải bảng lịch sử ⇒ []. */
export const recordRowsOfTable = (rows: readonly string[][]): RocRow[] => {
  if (!rows.some((r) => r.some((c) => c.trim()))) return []
  const { shape, columns } = recordColumns(rows)
  if (!columns.includes("description")) return []
  return shape.body.flatMap((r) => {
    const row = rows[r]
    if (row.some((c) => LEGEND.test(c.trim()))) return []
    const cell = (column: Column) => (row[columns.indexOf(column)] ?? "").trim()
    const description = [cell("item"), cell("description")].filter(Boolean).join(": ")
    if (!description && !cell("date") && !cell("version")) return []
    return [
      {
        date: cell("date"),
        version: cell("version"),
        change_type: changeType(cell("change_type")),
        in_charge: cell("in_charge"),
        description
      }
    ]
  })
}

/**
 * Dòng Record of Changes của file gốc: mọi bảng nằm dưới heading khớp `fixed:I` (tới heading kế tiếp cùng cấp hoặc
 * cao hơn). `headingSections` = `block_id` heading ⇒ section (profile `heading_map`).
 * Không có heading đó (bìa / trang lịch sử gõ đoạn thường) ⇒ bảng trông như bảng lịch sử nằm trước heading nội dung đầu tiên.
 */
export const legacyRecordRows = (blocks: readonly RecordSourceBlock[], headingSections: ReadonlyMap<string, string>): RocRow[] => {
  const out: RocRow[] = []
  let inside: number | null = null
  for (const b of blocks) {
    if (b.kind === "heading") {
      const level = b.level ?? 1
      if (inside !== null && level <= inside) inside = null
      if (headingSections.get(b.block_id) === RECORD_SECTION) inside = level
      continue
    }
    if (inside !== null && b.kind === "table" && b.rows) out.push(...recordRowsOfTable(b.rows))
  }
  if (out.length) return out
  for (const b of blocks) {
    const section = b.kind === "heading" ? headingSections.get(b.block_id) : undefined
    if (section && section !== RECORD_SECTION && section !== "unmapped") break
    if (b.kind === "table" && b.rows && looksLikeRecordTable(b.rows)) out.push(...recordRowsOfTable(b.rows))
  }
  return out
}
