/**
 * orthogonal-place.ts
 * ─────────────────────────────────────────────────────────────────
 * Xếp nút của đồ thị vào lưới ô (hàng, cột) cho sơ đồ nối bằng đường vuông góc (ERD; class diagram dùng lại). Không biết
 * hình dạng nút: chỉ nhận id và các cặp nối cha → con, trả ô của từng nút. Tất định (thứ tự theo `ids` đã sắp).
 *
 * Mỗi thành phần liên thông: phá chu trình bằng DFS (cạnh quay lại bị đảo chiều) → hạng = đường dài nhất từ nút gốc →
 * nút chỉ có cạnh đi ra kéo sát nút con đầu tiên → xếp thứ tự trong hạng bằng barycenter → gán cột bằng trung bình cột của
 * các nút nối (hai lượt xuống / lên). Các thành phần được xếp thành dải (shelf) để hình không quá dài.
 */

export interface Cell {
  row: number
  col: number
}

interface Component {
  cells: Map<string, Cell>
  rows: number
  cols: number
}

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length

const layoutComponent = (nodes: readonly string[], out: ReadonlyMap<string, readonly string[]>, inn: ReadonlyMap<string, readonly string[]>): Component => {
  const members = new Set(nodes)
  const order = new Map(nodes.map((id, i) => [id, i]))
  const kids = (id: string): string[] => (out.get(id) ?? []).filter((n) => members.has(n))
  const parents = (id: string): string[] => (inn.get(id) ?? []).filter((n) => members.has(n))

  // 1. phá chu trình: cạnh tới nút đang mở bị đảo chiều
  const dagOut = new Map<string, Set<string>>(nodes.map((id) => [id, new Set()]))
  const state = new Map<string, 1 | 2>()
  const visit = (u: string): void => {
    state.set(u, 1)
    for (const v of kids(u)) {
      if (state.get(v) === 1) dagOut.get(v)!.add(u)
      else {
        dagOut.get(u)!.add(v)
        if (!state.has(v)) visit(v)
      }
    }
    state.set(u, 2)
  }
  const roots = nodes.filter((id) => parents(id).length === 0)
  for (const id of [...roots, ...nodes]) if (!state.has(id)) visit(id)
  // đảo cạnh có thể sinh cặp hai chiều giữa hai nút: giữ một chiều
  for (const [u, vs] of dagOut) for (const v of [...vs]) if (dagOut.get(v)!.has(u) && order.get(u)! > order.get(v)!) vs.delete(v)

  // 2. hạng = đường dài nhất (Kahn)
  const indeg = new Map(nodes.map((id) => [id, 0]))
  for (const vs of dagOut.values()) for (const v of vs) indeg.set(v, (indeg.get(v) ?? 0) + 1)
  const rank = new Map<string, number>(nodes.map((id) => [id, 0]))
  const queue = nodes.filter((id) => indeg.get(id) === 0)
  const topo: string[] = []
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i]
    topo.push(u)
    for (const v of [...dagOut.get(u)!].sort((a, b) => order.get(a)! - order.get(b)!)) {
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1))
      indeg.set(v, indeg.get(v)! - 1)
      if (indeg.get(v) === 0) queue.push(v)
    }
  }
  // 3. nút gốc chỉ có cạnh đi ra: sát nút con đầu tiên
  for (const u of [...topo].reverse()) {
    const hasIn = nodes.some((p) => dagOut.get(p)!.has(u))
    const below = [...dagOut.get(u)!].map((v) => rank.get(v)!)
    if (!hasIn && below.length > 0) rank.set(u, Math.min(...below) - 1)
  }
  const minRank = Math.min(...nodes.map((id) => rank.get(id)!))
  for (const id of nodes) rank.set(id, rank.get(id)! - minRank)

  const neighbours = (id: string): string[] => [...new Set([...kids(id), ...parents(id)])].filter((n) => n !== id)
  const maxRank = Math.max(...nodes.map((id) => rank.get(id)!))
  const layers: string[][] = Array.from({ length: maxRank + 1 }, (_, r) => nodes.filter((id) => rank.get(id) === r))

  // 4. thứ tự trong hạng: barycenter xuống / lên
  const position = new Map<string, number>()
  layers.forEach((layer) => layer.forEach((id, i) => position.set(id, i)))
  for (let pass = 0; pass < 6; pass++) {
    const down = pass % 2 === 0
    const ranks = down ? [...layers.keys()] : [...layers.keys()].reverse()
    for (const r of ranks) {
      const keyOf = (id: string): number => {
        const side = neighbours(id).filter((n) => (down ? rank.get(n)! < r : rank.get(n)! > r))
        return side.length > 0 ? mean(side.map((n) => position.get(n)!)) : position.get(id)!
      }
      const keys = new Map(layers[r].map((id) => [id, keyOf(id)]))
      layers[r].sort((a, b) => keys.get(a)! - keys.get(b)! || position.get(a)! - position.get(b)!)
      layers[r].forEach((id, i) => position.set(id, i))
    }
  }

  // 5. cột: trung bình cột của nút nối, rồi đẩy sang phải cho khỏi trùng
  const col = new Map(position)
  for (let pass = 0; pass < 5; pass++) {
    const down = pass % 2 === 0
    const ranks = down ? [...layers.keys()] : [...layers.keys()].reverse()
    for (const r of ranks) {
      let prev = -Infinity
      for (const id of layers[r]) {
        const side = neighbours(id).filter((n) => (down ? rank.get(n)! < r : rank.get(n)! > r))
        const want = side.length > 0 ? Math.round(mean(side.map((n) => col.get(n)!))) : col.get(id)!
        const next = Math.max(want, prev + 1)
        col.set(id, next)
        prev = next
      }
    }
  }
  const used = [...new Set(nodes.map((id) => col.get(id)!))].sort((a, b) => a - b)
  const dense = new Map(used.map((c, i) => [c, i]))
  const cells = new Map(nodes.map((id): [string, Cell] => [id, { row: rank.get(id)!, col: dense.get(col.get(id)!)! }]))
  return { cells, rows: maxRank + 1, cols: used.length }
}

/** `links`: cặp cha → con (id ngoài `ids` và tự nối bị bỏ). `maxCols`: bề rộng dải khi xếp nhiều thành phần. */
export const placeOnGrid = (ids: readonly string[], links: readonly (readonly [string, string])[], maxCols: number): Map<string, Cell> => {
  const known = new Set(ids)
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  const inn = new Map<string, string[]>(ids.map((id) => [id, []]))
  const und = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]))
  for (const [a, b] of links) {
    if (a === b || !known.has(a) || !known.has(b) || out.get(a)!.includes(b)) continue
    out.get(a)!.push(b)
    inn.get(b)!.push(a)
    und.get(a)!.add(b)
    und.get(b)!.add(a)
  }
  const index = new Map(ids.map((id, i) => [id, i]))
  const byIndex = (a: string, b: string): number => index.get(a)! - index.get(b)!
  for (const list of [...out.values(), ...inn.values()]) list.sort(byIndex)

  const seen = new Set<string>()
  const components: Component[] = []
  for (const start of ids) {
    if (seen.has(start)) continue
    const members = [start]
    seen.add(start)
    for (let i = 0; i < members.length; i++) {
      for (const n of [...und.get(members[i])!].sort(byIndex)) {
        if (seen.has(n)) continue
        seen.add(n)
        members.push(n)
      }
    }
    components.push(layoutComponent(members.sort(byIndex), out, inn))
  }

  // dải: thành phần lớn trước, tới hết bề rộng thì xuống dải mới
  const sorted = [...components].sort((a, b) => b.cells.size - a.cells.size)
  const result = new Map<string, Cell>()
  let x = 0
  let y = 0
  let bandHeight = 0
  for (const comp of sorted) {
    if (x > 0 && x + comp.cols > maxCols) {
      y += bandHeight
      x = 0
      bandHeight = 0
    }
    for (const [id, cell] of comp.cells) result.set(id, { row: y + cell.row, col: x + cell.col })
    x += comp.cols
    bandHeight = Math.max(bandHeight, comp.rows)
  }
  return result
}
