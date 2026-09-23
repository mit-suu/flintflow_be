/**
 * Record of Changes của file gốc (nợ T15, mode 1 v3): mục `fixed:I` là mục tự sinh từ lịch sử thay đổi của FlintFlow,
 * nên trước đây bảng lịch sử sửa đổi **của khách** trong file upload bị thay mất. Import đọc lại bảng đó (khối bảng nằm
 * dưới heading khớp `fixed:I`) thành các dòng `RocRow`; render in các dòng cũ lên đầu bảng, lịch sử FlintFlow nối tiếp.
 * Hàm thuần — không DB.
 */

import type { RocChangeType, RocRow } from "../render/rendered-document.types.js"

export interface RecordSourceBlock {
  block_id: string
  kind: string
  level: number | null
  rows?: string[][] | null
}

const RECORD_SECTION = "fixed:I"

type Column = keyof RocRow

/** Nhận cột theo chữ tiêu đề (mẫu FPT tiếng Anh + tiếng Việt). */
const COLUMN_PATTERNS: [Column, RegExp][] = [
  ["date", /\b(date|ngày)\b/i],
  ["version", /\b(version|phiên bản|ver)\b/i],
  ["change_type", /(a\*|a,\s*m|\bm,\s*d|\btype\b|\bloại\b)/i],
  ["in_charge", /(in charge|người|author|thực hiện|phụ trách)/i],
  ["description", /(description|mô tả|nội dung|change)/i]
]

const columnOf = (header: string): Column | null => {
  for (const [column, pattern] of COLUMN_PATTERNS) if (pattern.test(header)) return column
  return null
}

const changeType = (raw: string): RocChangeType => {
  const v = raw.trim().toUpperCase()
  return v.startsWith("A") ? "A" : v.startsWith("D") ? "D" : "M"
}

/** Một bảng Record of Changes ⇒ các dòng; bảng không có cột mô tả nhận ra được ⇒ không phải bảng lịch sử ⇒ []. */
export const recordRowsOfTable = (rows: readonly string[][]): RocRow[] => {
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()))
  if (!header) return []
  const columns = header.map((h) => columnOf(h))
  if (!columns.includes("description")) return []
  return body.map((r) => {
    const cell = (column: Column) => (r[columns.indexOf(column)] ?? "").trim()
    return {
      date: cell("date"),
      version: cell("version"),
      change_type: changeType(cell("change_type")),
      in_charge: cell("in_charge"),
      description: cell("description")
    }
  })
}

/**
 * Dòng Record of Changes của file gốc: mọi bảng nằm dưới heading khớp `fixed:I` (tới heading kế tiếp cùng cấp hoặc
 * cao hơn). `headingSections` = `block_id` heading ⇒ section (profile `heading_map`).
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
  return out
}
