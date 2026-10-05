/**
 * Hình dạng một bảng đọc theo cả tiêu đề lẫn dữ liệu (FLF-252). Hàm thuần.
 * - Hàng tiêu đề: hàng đầu tiên đủ ô và có ≥ 2 ô chữ — hàng tên bảng gộp cả bảng ("Table 3: Actors") bị bỏ qua.
 * - Hàng nhóm: hàng có ô gộp (ít ô hơn hàng tiêu đề — parser đọc theo `w:tc`) và ≤ 2 ô có chữ: "PUBLIC SCREENS",
 *   "1 | Account & Organization". Không phải phần tử — nhãn nhóm cho các hàng bên dưới.
 * - Vai trò cột theo dữ liệu: số thứ tự (1, 2, 3 — không dùng làm mã), mã (`UC-01`, tiền tố cho biết loại phần tử),
 *   ngày, phiên bản, loại thay đổi A/M/D, ô đánh dấu của ma trận (X / ✓ / view), chữ dài, tên.
 */

export type ColumnRole = "row_no" | "code" | "date" | "version" | "change_type" | "mark" | "text" | "name" | "empty"

export interface ColumnProfile {
  index: number
  role: ColumnRole
  /** Tiền tố mã chiếm đa số (`UC`, `BR`, `MSG`) — chỉ với `code`. */
  prefix: string | null
  /** Tối đa 3 giá trị đầu tiên của cột (hiện ở bước xác nhận mapping). */
  samples: string[]
}

export interface TableShape {
  /** Chỉ số hàng tiêu đề trong `rows`. */
  header: number
  headers: string[]
  /** Chỉ số các hàng dữ liệu (không gồm hàng nhóm, hàng trống). */
  body: number[]
  groups: { row: number; label: string }[]
  columns: ColumnProfile[]
}

const filled = (row: readonly string[]): string[] => row.map((c) => (c ?? "").trim()).filter(Boolean)

/** Hàng tiêu đề: hàng đầu tiên (trong 3 hàng đầu) đủ ô và có ≥ 2 ô chữ; không có ⇒ hàng 0. */
export const headerRowIndex = (rows: readonly string[][]): number => {
  const width = Math.max(0, ...rows.map((r) => r.length))
  for (let i = 0; i < Math.min(rows.length, 3); i++) {
    if (rows[i].length === width && filled(rows[i]).length >= Math.min(2, width)) return i
  }
  return 0
}

const SEQ = /^\d{1,3}[.)]?$/
/** `UC-01`, `UC01`, `BR_12`, `MSG001`, `NFR-P01`, `AUTH-001`, `FR-3.2.1`. */
const CODE = /^([A-Za-z]{1,6})(?:[-_ ]?[A-Za-z]{1,3})?[-_ ]?\d{1,4}(?:\.\d{1,3})*$/
const DATE = /^(?:\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{4}[/.-]\d{1,2}[/.-]\d{1,2})$/
const VERSION = /^v?\d{1,2}(?:\.\d{1,3}){1,2}$/i
const CHANGE = /^(?:a|m|d|add(?:ed)?|modif(?:y|ied)|delete(?:d)?|thêm|sửa|xoá|xóa)$/i
const MARK = /^(?:x|✓|✔|√|•|●|o|y|yes|có)$/i
/** Ô ghi "không có" (gạch ngang, N/A) — coi như ô trống: không tính vào vai trò cột, không thành quyền. */
const NONE = /^(?:[-–—]+|n\/?a|none|không)$/i
const ACTION_WORD =
  "view|read|list|search|create|add|update|edit|write|delete|remove|approve|reject|submit|assign|publish|confirm|cancel|" +
  "upload|download|export|import|print|send|execute|run|manage|full|all|access|crud|[rcud]"
const ACTION = new RegExp(`^(?:${ACTION_WORD})(?:\\s*[,/;&+]\\s*(?:${ACTION_WORD}))*$`, "i")

const share = (values: string[], re: RegExp): number => (values.length ? values.filter((v) => re.test(v)).length / values.length : 0)

const isSequence = (values: string[]): boolean => {
  if (values.length < 2 || !values.every((v) => SEQ.test(v))) return false
  const nums = values.map((v) => Number.parseInt(v, 10))
  let steps = 0
  for (let i = 1; i < nums.length; i++) if (nums[i] === nums[i - 1] + 1) steps++
  return steps / (nums.length - 1) >= 0.8
}

const majorityPrefix = (values: string[]): string | null => {
  const counts = new Map<string, number>()
  for (const v of values) {
    const m = CODE.exec(v)
    if (m) counts.set(m[1].toUpperCase(), (counts.get(m[1].toUpperCase()) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** Vai trò của một cột theo các giá trị (đã bỏ ô trống). */
export const columnRole = (values: string[]): { role: ColumnRole; prefix: string | null } => {
  if (!values.length) return { role: "empty", prefix: null }
  if (isSequence(values)) return { role: "row_no", prefix: null }
  if (share(values, DATE) >= 0.6) return { role: "date", prefix: null }
  // phiên bản trước mã: "v1.0" cũng khớp dạng mã
  if (share(values, VERSION) >= 0.6) return { role: "version", prefix: null }
  if (share(values, CODE) >= 0.6 && !values.every((v) => /^\d+$/.test(v))) return { role: "code", prefix: majorityPrefix(values) }
  if (share(values, CHANGE) >= 0.6) return { role: "change_type", prefix: null }
  if (values.filter((v) => MARK.test(v) || ACTION.test(v)).length / values.length >= 0.6) return { role: "mark", prefix: null }
  const avg = values.reduce((n, v) => n + v.length, 0) / values.length
  return { role: avg >= 40 ? "text" : "name", prefix: null }
}

export const tableShape = (rows: readonly string[][]): TableShape => {
  const header = headerRowIndex(rows)
  const headers = (rows[header] ?? []).map((c) => (c ?? "").trim())
  const width = headers.length
  const body: number[] = []
  const groups: TableShape["groups"] = []
  for (let r = header + 1; r < rows.length; r++) {
    const cells = filled(rows[r])
    if (!cells.length) continue
    // Ô gộp ngang (ít ô hơn tiêu đề) + ít chữ ⇒ hàng nhóm; bảng 1–2 cột không có khái niệm hàng nhóm
    if (width >= 3 && rows[r].length < width && cells.length <= 2) {
      groups.push({ row: r, label: cells[cells.length - 1] })
      continue
    }
    body.push(r)
  }
  const columns = headers.map((_, index) => {
    const values = body.map((r) => (rows[r][index] ?? "").trim()).filter((v) => v && !NONE.test(v))
    return { index, ...columnRole(values), samples: values.slice(0, 3) }
  })
  return { header, headers, body, groups, columns }
}

/** Nhãn nhóm của một hàng dữ liệu: hàng nhóm gần nhất phía trên; không có ⇒ `null`. */
export const groupOf = (shape: TableShape, row: number): string | null => {
  let label: string | null = null
  for (const g of shape.groups) if (g.row < row) label = g.label
  return label
}

/**
 * Cột của bảng ma trận (bảng phân quyền màn hình × vai trò): bỏ cột số thứ tự đứng đầu ("#"), cột kế tiếp là tên, mọi cột
 * sau đó là ô đánh dấu hoặc trống và có ≥ 2 cột đánh dấu. Không phải ma trận ⇒ `null`.
 */
export const markMatrixColumns = (shape: TableShape): { nameColumn: number; markColumns: number[] } | null => {
  let nameColumn = 0
  while (shape.columns[nameColumn]?.role === "row_no") nameColumn++
  const rest = shape.columns.slice(nameColumn + 1)
  if (rest.filter((c) => c.role === "mark").length < 2 || !rest.every((c) => c.role === "mark" || c.role === "empty")) return null
  return { nameColumn, markColumns: rest.map((c) => c.index) }
}

export const isMarkMatrix = (shape: TableShape): boolean => markMatrixColumns(shape) !== null

/** Ô đánh dấu ⇒ thao tác: "X"/"✓" ⇒ `access`; "view, create" ⇒ hai thao tác; ô trống / "—" ⇒ không có quyền. */
export const markActions = (cell: string): string[] => {
  const v = cell.trim()
  if (!v || NONE.test(v)) return []
  if (MARK.test(v)) return ["access"]
  return v
    .split(/[,/;&+]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
}
