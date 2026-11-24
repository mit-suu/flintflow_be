/**
 * So hai bảng theo hàng (so sánh version UC-50, tải lại file UC-25) — hàm thuần. Ghép hàng ba tầng:
 *  1. Cột mã (cùng tiêu đề ở hai bảng, mọi ô thân có dạng mã như `UC-01`, `NFR-17`, không trùng) ⇒ ghép theo mã rồi so từng ô;
 *     đổi thứ tự hàng không tính là thay đổi.
 *  2. Hàng còn lại: LCS theo chữ cả hàng; hàng y hệt nằm ngoài dãy LCS ⇒ `moved` (FE không tô xanh / đỏ).
 *  3. Hàng còn lẻ giữa hai hàng đã ghép ⇒ ghép theo độ giống từ (≥ `MODIFIED_SIMILARITY`) ⇒ `modified` kèm chỉ số ô đổi; còn lại
 *     mới là `added` / `removed`.
 * Kết quả theo thứ tự bảng mới, hàng bị xoá chen vào đúng chỗ; hàng không đổi gộp thành một nhóm `unchanged` (FE vẽ `⋯ n hàng`).
 */
import { foldText } from "../import/text-similarity.js"

export type RowChange = "added" | "removed" | "modified" | "moved"

export type TableRowDiff =
  | { change: RowChange; before?: string[]; after?: string[]; cells_changed?: number[] }
  /** Hàng không đổi liền nhau: `count` hàng, kèm chữ để FE mở ra khi bấm `⋯ n hàng`. */
  | { change: "unchanged"; count: number; rows: string[][] }

export interface TableDiff {
  /** Hàng tiêu đề của bảng mới (bảng mới không có hàng nào ⇒ của bảng cũ). */
  header: string[]
  /** Chỉ khi hàng tiêu đề đổi. */
  header_before?: string[]
  rows: TableRowDiff[]
}

/** Trần số hàng mỗi bảng để so theo hàng (LCS n × m): bảng lớn hơn (file tải lại do người dùng đưa lên) ⇒ không so theo hàng. */
export const MAX_DIFF_ROWS = 2000

/** Ngưỡng giống từ để coi hai hàng là một hàng bị sửa (cùng thang với block). */
export const ROW_SIMILARITY = 0.5

const ID_CELL = /^[A-Za-z]{1,8}[-_.]?\d+(?:[.-]\d+)*[a-z]?$/

const rowText = (r: readonly string[]): string => r.map((c) => c.trim()).join(" | ")

const words = (s: string): Set<string> => new Set(s.toLowerCase().split(/\s+/).filter(Boolean))
const similarity = (a: string, b: string): number => {
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

const lcs = (a: string[], b: string[]): [number, number][] => {
  const n = a.length
  const m = b.length
  if (!n || !m) return []
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

/** Cột mã dùng chung: cùng tiêu đề (gập dấu), mọi ô thân không rỗng có dạng mã và không trùng trong từng bảng. */
const idColumns = (headerA: readonly string[], headerB: readonly string[], a: readonly string[][], b: readonly string[][]): [number, number] | null => {
  const isIdColumn = (rows: readonly string[][], c: number): boolean => {
    const cells = rows.map((r) => (r[c] ?? "").trim()).filter(Boolean)
    return cells.length >= 1 && cells.length === rows.length && cells.every((v) => ID_CELL.test(v)) && new Set(cells).size === cells.length
  }
  for (let ca = 0; ca < headerA.length; ca++) {
    const cb = headerB.findIndex((h) => foldText(h) === foldText(headerA[ca]))
    if (cb >= 0 && isIdColumn(a, ca) && isIdColumn(b, cb)) return [ca, cb]
  }
  return null
}

const changedCells = (a: readonly string[], b: readonly string[]): number[] => {
  const out: number[] = []
  for (let c = 0; c < Math.max(a.length, b.length); c++) if ((a[c] ?? "").trim() !== (b[c] ?? "").trim()) out.push(c)
  return out
}

/** `null` ⇒ hai bảng giống nhau về nội dung (kể cả chỉ đổi thứ tự hàng theo mã). */
/** Hai bảng đủ nhỏ để so theo hàng. */
export const rowDiffable = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length <= MAX_DIFF_ROWS && b.length <= MAX_DIFF_ROWS

export const diffTableRows = (beforeRows: readonly string[][], afterRows: readonly string[][]): TableDiff | null => {
  const headerB = beforeRows[0] ?? []
  const headerA = afterRows[0] ?? headerB
  const before = beforeRows.slice(1)
  const after = afterRows.slice(1)
  const matchOf = new Map<number, number>() // after j ⇒ before i
  const used = new Set<number>()
  /** Cặp ghép theo mã: đổi chỗ không tính là di chuyển. */
  const byKey = new Set<number>()

  const ids = idColumns(headerB, headerA, before, after)
  if (ids) {
    const index = new Map(before.map((r, i) => [(r[ids[0]] ?? "").trim(), i]))
    after.forEach((r, j) => {
      const i = index.get((r[ids[1]] ?? "").trim())
      if (i === undefined || used.has(i)) return
      matchOf.set(j, i)
      used.add(i)
      byKey.add(j)
    })
  }

  const restB = before.map((_, i) => i).filter((i) => !used.has(i))
  const restA = after.map((_, j) => j).filter((j) => !matchOf.has(j))
  for (const [x, y] of lcs(restB.map((i) => rowText(before[i])), restA.map((j) => rowText(after[j])))) {
    matchOf.set(restA[y], restB[x])
    used.add(restB[x])
  }
  // Hàng y hệt ngoài dãy LCS ⇒ di chuyển
  const moved = new Set<number>()
  after.forEach((r, j) => {
    if (matchOf.has(j)) return
    const i = before.findIndex((x, k) => !used.has(k) && rowText(x) === rowText(r))
    if (i < 0) return
    matchOf.set(j, i)
    used.add(i)
    moved.add(j)
  })
  // Hàng lẻ giữa hai hàng đã ghép ⇒ theo độ giống
  after.forEach((r, j) => {
    if (matchOf.has(j)) return
    let lo = -1
    let hi = before.length
    for (const [jj, ii] of matchOf) {
      if (byKey.has(jj) || moved.has(jj)) continue
      if (jj < j && ii > lo) lo = ii
      if (jj > j && ii < hi) hi = ii
    }
    let best = -1
    let bestScore = ROW_SIMILARITY
    for (let i = lo + 1; i < hi; i++) {
      if (used.has(i)) continue
      const score = similarity(rowText(before[i]), rowText(r))
      if (score >= bestScore) {
        best = i
        bestScore = score
      }
    }
    if (best >= 0) {
      matchOf.set(j, best)
      used.add(best)
    }
  })

  const out: TableRowDiff[] = []
  let changes = 0
  const pushUnchanged = (row: string[]): void => {
    const last = out[out.length - 1]
    if (last?.change === "unchanged") {
      last.count++
      last.rows.push(row)
    } else out.push({ change: "unchanged", count: 1, rows: [row] })
  }
  const emitted = new Set<number>()
  /** Hàng cũ bị xoá đứng trước hàng cũ `upTo` (theo thứ tự bảng cũ) chen vào trước. */
  const flushRemoved = (upTo: number): void => {
    for (let i = 0; i < upTo; i++) {
      if (used.has(i) || emitted.has(i)) continue
      emitted.add(i)
      out.push({ change: "removed", before: before[i] })
      changes++
    }
  }
  after.forEach((r, j) => {
    const i = matchOf.get(j)
    if (i === undefined) {
      out.push({ change: "added", after: r })
      changes++
      return
    }
    if (!byKey.has(j) && !moved.has(j)) flushRemoved(i)
    const cells = changedCells(before[i], r)
    if (cells.length) {
      out.push({ change: "modified", before: before[i], after: r, cells_changed: cells })
      changes++
    } else if (moved.has(j)) {
      out.push({ change: "moved", before: before[i], after: r })
      changes++
    } else pushUnchanged(r)
  })
  flushRemoved(before.length)

  const headerChanged = changedCells(headerB, headerA).length > 0
  if (!changes && !headerChanged) return null
  return { header: headerA, ...(headerChanged ? { header_before: headerB } : {}), rows: out }
}
