/**
 * Ô của một bảng đã tách (FLF-251). Hàm thuần.
 * - `tableRows`: lấy `rows` lưu trên block bảng (parser đọc theo `w:tc`); bản ghi cũ chưa có ⇒ dựng từ block `table_cell`.
 *   Không tách lại `text` của bảng theo dòng: ô có xuống dòng (tiêu đề "A*⏎M, D" của Record of Changes) làm gãy hàng.
 * - `tableText`: bảng dạng `| ô | ô |` một hàng một dòng cho prompt — xuống dòng trong ô thành " / ".
 */

export interface TableBlockLike {
  kind: string
  text: string
  anchor: { xml_path: string }
  rows?: string[][] | null
}

const CELL_PATH = /\/tr\[(\d+)\]\/tc\[(\d+)\]\/p\[\d+\]$/

/** Dựng lưới ô của bảng từ block `table_cell` (đoạn cùng ô nối bằng xuống dòng). */
export const tableGrid = (table: TableBlockLike, blocks: readonly TableBlockLike[]): string[][] => {
  const grid: string[][] = []
  const prefix = `${table.anchor.xml_path}/tr[`
  for (const b of blocks) {
    if (b.kind !== "table_cell" || !b.anchor.xml_path.startsWith(prefix)) continue
    const m = CELL_PATH.exec(b.anchor.xml_path)
    if (!m) continue
    const [r, c] = [Number(m[1]), Number(m[2])]
    grid[r] ??= []
    grid[r][c] = grid[r][c] ? `${grid[r][c]}\n${b.text}` : b.text
  }
  return grid.map((row) => Array.from(row ?? [], (cell) => (cell ?? "").trim()))
}

/** Ô của bảng theo hàng: `rows` đã lưu, không có thì dựng từ block ô. */
export const tableRows = (table: TableBlockLike, blocks: readonly TableBlockLike[]): string[][] =>
  table.rows?.length ? table.rows.map((row) => row.map((cell) => (cell ?? "").trim())) : tableGrid(table, blocks)

const cellText = (cell: string): string => cell.replace(/\s*\n\s*/g, " / ").replace(/\|/g, "/").trim()

/** Bảng cho prompt: mỗi hàng một dòng `| ô | ô |`, ô nhiều dòng nối bằng " / ". */
export const tableText = (rows: readonly string[][]): string => rows.map((row) => `| ${row.map(cellText).join(" | ")} |`).join("\n")
