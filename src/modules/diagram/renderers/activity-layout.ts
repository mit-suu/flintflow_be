/**
 * Hình học sơ đồ activity (UML 2.5) — luồng xử lý của một function (FLF-390). Dựa trên bố cục swimlane của luồng màn
 * kiểu activity cũ (FLF-340): làn (ActivityPartition) kẻ dọc, mỗi làn một hoặc nhiều cột ô; luồng đi từ trên xuống, hàng
 * = hạng (đường dài nhất từ nút vào theo các cạnh tiến).
 *
 * Mọi đường đều song song trục và chỉ có bốn dạng:
 *   - thẳng đứng: cùng cột, không có ô nào chắn giữa;
 *   - chữ Z: nút ở hàng kề, một đoạn ngang trong khe giữa hai hàng;
 *   - chữ Z kép: nút xa hơn một hàng, đi dọc một đường rãnh (gutter) giữa các cột — rãnh không bao giờ có ô;
 *   - vòng lặp (cạnh quay lại nút ở hàng trên): xuống khe dưới nút nguồn, sang rãnh, đi lên rãnh tới khe trên nút đích,
 *     rồi vào nút đích từ cạnh trên.
 * Mỗi đoạn ngang có tung độ riêng trong khe, mỗi đoạn dọc trong rãnh có hoành độ riêng, các cổng ở cạnh trên / dưới nút
 * có hoành độ riêng trong từng nhóm cổng ⇒ không đoạn nào chồng đoạn nào.
 *
 * Guard `[điều kiện]` của control flow là một ô riêng trên lưới (nút ảo không có hình) mà đường của chính flow đó đi
 * xuyên qua: không đường nào khác đi qua ô nên nhãn không bao giờ bị cắt hay đè.
 */

import { textWidth, FILL, INK, PAPER, type Point } from "../../../shared/diagram/svg-kit.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"
import { wrapLines } from "./usecase-layout.js"
import type { ActivityNodeKind } from "../../spine/spine.types.js"

// ─── dữ liệu vào ────────────────────────────────────────────────────

export interface ActivityLane {
  id: string
  name: string
}
export interface ActivityLayoutNode {
  id: string
  kind: ActivityNodeKind
  /** Chữ của action / câu hỏi của decision. */
  name: string
  /** Chỉ số làn trong `lanes` (0 khi không có làn). */
  lane: number
}
export interface ActivityLayoutFlow {
  from: string
  to: string
  guard: string
}
export interface ActivityLayoutInput {
  /** Rỗng ⇒ không vẽ khung làn. */
  lanes: readonly ActivityLane[]
  /** Theo thứ tự dữ liệu. */
  nodes: readonly ActivityLayoutNode[]
  flows: readonly ActivityLayoutFlow[]
}

// ─── đồ thị: nút vào, cạnh tiến / cạnh quay lại, hạng ──────────────

export interface ActivityPlan {
  /** Cạnh tiến (đi xuống), theo thứ tự dữ liệu. */
  forward: [string, string][]
  /** Cạnh quay lại (đóng vòng lặp, đi lên). */
  back: [string, string][]
  rank: Map<string, number>
}

/**
 * Phân loại cạnh bằng DFS: bắt đầu từ các nút `initial` (theo thứ tự), rồi nút không có cạnh vào, rồi nút còn lại. Cạnh
 * tới nút đang mở trên ngăn xếp là cạnh quay lại; còn lại là cạnh tiến (đồ thị cạnh tiến không có chu trình). Hạng =
 * đường dài nhất theo cạnh tiến.
 */
export const planActivity = (ids: readonly string[], starts: ReadonlySet<string>, edges: readonly (readonly [string, string])[]): ActivityPlan => {
  const index = new Map(ids.map((id, i) => [id, i]))
  const next = new Map<string, string[]>(ids.map((id) => [id, []]))
  const hasIn = new Set<string>()
  for (const [from, to] of edges) {
    if (from === to || !index.has(from) || !index.has(to) || next.get(from)!.includes(to)) continue
    next.get(from)!.push(to)
    hasIn.add(to)
  }
  const state = new Map<string, 1 | 2>()
  const forward: [string, string][] = []
  const back: [string, string][] = []
  const finished: string[] = []
  const walk = (root: string): void => {
    // DFS lặp (đồ thị lớn không tràn ngăn xếp gọi hàm)
    const stack: { id: string; i: number }[] = [{ id: root, i: 0 }]
    state.set(root, 1)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const targets = next.get(top.id)!
      if (top.i < targets.length) {
        const to = targets[top.i++]
        if (state.get(to) === 1) back.push([top.id, to])
        else {
          forward.push([top.id, to])
          if (!state.has(to)) {
            state.set(to, 1)
            stack.push({ id: to, i: 0 })
          }
        }
      } else {
        state.set(top.id, 2)
        finished.push(top.id)
        stack.pop()
      }
    }
  }
  for (const id of ids) if (starts.has(id) && !state.has(id)) walk(id)
  for (const id of ids) if (!hasIn.has(id) && !state.has(id)) walk(id)
  for (const id of ids) if (!state.has(id)) walk(id)

  const preds = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [from, to] of forward) preds.get(to)!.push(from)
  const rank = new Map<string, number>()
  for (const id of [...finished].reverse()) rank.set(id, Math.max(0, ...preds.get(id)!.map((p) => (rank.get(p) ?? 0) + 1)))
  const order = (a: readonly [string, string], b: readonly [string, string]) => index.get(a[0])! - index.get(b[0])! || index.get(a[1])! - index.get(b[1])!
  return { forward: forward.sort(order), back: back.sort(order), rank }
}

// ─── kích thước ─────────────────────────────────────────────────────

const TEXT = 13
const LINE = 16
export const CELL_W = 176
const ACTION_MIN_H = 40
const PAD_X = 14
const PAD_Y = 10
const RADIUS = 10
const TEXT_W = CELL_W - 2 * PAD_X
const INIT_R = 10
const FINAL_R = 15
const FINAL_INNER = 9
const DIAMOND = 40
const BAR_W = 132
const BAR_H = 6
const LABEL_SIZE = 12
const LABEL_LINE = 15
const HEAD_SIZE = 14
const HEAD_LINE = 18
const GUTTER_PAD = 14
const TRACK_GAP = 12
const GUTTER_MIN = 30
const GAP_PAD = 16
const RUN_GAP = 12
const GAP_MIN = 40
const EDGE_GAP_MIN = 18
const PORT_STEP = 22

const clean = (text: string): string => text.replace(/\s+/g, " ").trim()

/** Từ dài hơn `max` px bị cắt thành các đoạn vừa dòng (không mất chữ). */
const breakLongWords = (text: string, size: number, max: number): string => {
  const parts: string[] = []
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    let rest = Array.from(word)
    while (textWidth(rest.join(""), size) > max && rest.length > 1) {
      let n = rest.length - 1
      while (n > 1 && textWidth(rest.slice(0, n).join(""), size) > max) n--
      parts.push(rest.slice(0, n).join(""))
      rest = rest.slice(n)
    }
    parts.push(rest.join(""))
  }
  return parts.join(" ")
}

/** Gói dòng tham lam, mỗi dòng ≤ `max` px; không mất chữ. */
export const wrapText = (text: string, size: number, max: number): string[] => {
  const lines: string[] = []
  for (const word of breakLongWords(clean(text), size, max).split(" ").filter((w) => w !== "")) {
    const last = lines.length - 1
    if (last >= 0 && textWidth(`${lines[last]} ${word}`, size) <= max) lines[last] = `${lines[last]} ${word}`
    else lines.push(word)
  }
  return lines
}

type CellKind = ActivityNodeKind | "label"

interface Cell {
  key: string
  kind: CellKind
  name: string
  lines: string[]
  lane: number
  order: number
  w: number
  h: number
  /** Nửa bề rộng mà cổng được phép lệch khỏi tâm. */
  span: number
  row: number
  slot: number
  col: number
}

/** Kích thước hình theo loại nút; decision / merge là **hình thoi** đúng UML (QLHS 11/11 — trước đây lục giác dẹt), câu hỏi nằm trong thoi. */
const sizeOf = (kind: CellKind, name: string): Pick<Cell, "lines" | "w" | "h" | "span"> => {
  switch (kind) {
    case "action": {
      const lines = wrapText(name || "-", TEXT, TEXT_W)
      return { lines, w: CELL_W, h: Math.max(ACTION_MIN_H, lines.length * LINE + 2 * PAD_Y), span: CELL_W / 2 - 16 }
    }
    case "decision":
    case "merge": {
      if (name === "") return { lines: [], w: DIAMOND, h: DIAMOND, span: DIAMOND / 2 - 6 }
      // Chữ nhật chữ (tw × th) nằm trong thoi khi tw/w + th/h ≤ 1 ⇒ thoi gấp đôi khối chữ mỗi chiều
      const lines = wrapText(name, TEXT, CELL_W / 2 - 8)
      const tw = Math.max(...lines.map((l) => textWidth(l, TEXT)))
      const w = Math.max(DIAMOND, 2 * tw + 16)
      const h = Math.max(DIAMOND, 2 * lines.length * LINE + 12)
      return { lines, w, h, span: w / 4 }
    }
    case "fork":
    case "join":
      return { lines: [], w: BAR_W, h: BAR_H, span: BAR_W / 2 - 8 }
    case "initial":
      return { lines: [], w: 2 * INIT_R, h: 2 * INIT_R, span: INIT_R - 4 }
    case "final":
      return { lines: [], w: 2 * FINAL_R, h: 2 * FINAL_R, span: FINAL_R - 2 }
    case "label": {
      const lines = wrapText(name, LABEL_SIZE, TEXT_W)
      return { lines, w: Math.max(...lines.map((l) => textWidth(l, LABEL_SIZE))) + 8, h: lines.length * LABEL_LINE + 6, span: CELL_W / 2 - 16 }
    }
  }
}

interface Link {
  id: string
  from: string
  to: string
  back: boolean
}

/** Bỏ điểm trùng liên tiếp và điểm giữa của ba điểm thẳng hàng cùng chiều. */
const simplify = (points: Point[]): Point[] => {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue
    if (out.length >= 2) {
      const a = out[out.length - 2]
      const b = out[out.length - 1]
      const sameX = Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(b[0] - p[0]) < 1e-6
      const sameY = Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(b[1] - p[1]) < 1e-6
      const forwardX = sameY && (b[0] - a[0]) * (p[0] - b[0]) > 0
      const forwardY = sameX && (b[1] - a[1]) * (p[1] - b[1]) > 0
      if (forwardX || forwardY) out[out.length - 1] = p
      else out.push(p)
      continue
    }
    out.push(p)
  }
  return out
}

/** Bố cục sơ đồ activity; `systemLane` không dùng ở đây (tên làn đã nằm trong `lanes`). */
export const layoutActivity = (d: ActivityLayoutInput): Scene => {
  const scene = new Scene()
  const lanes: ActivityLane[] = d.lanes.length > 0 ? [...d.lanes] : [{ id: "", name: "" }]
  const named = lanes.some((l) => l.name !== "")
  const known = new Set(d.nodes.map((n) => n.id))

  // ── ô: nút thật + ô nhãn guard (nút ảo nằm giữa nguồn và đích của flow có guard) ──
  const cells = new Map<string, Cell>()
  const addCell = (key: string, kind: CellKind, name: string, lane: number, order: number): void =>
    void cells.set(key, { key, kind, name, lane, order, ...sizeOf(kind, name), row: 0, slot: -1, col: -1 })
  d.nodes.forEach((n, i) => addCell(n.id, n.kind, clean(n.name), n.lane, i))

  /** Flow đã lọc (đầu mút có thật, không tự trỏ, không trùng) — mỗi flow một đường vẽ. */
  const flows: { id: string; from: string; to: string; label: string | null }[] = []
  const seen = new Set<string>()
  for (const f of d.flows) {
    const key = `${f.from}>${f.to}`
    if (f.from === f.to || !known.has(f.from) || !known.has(f.to) || seen.has(key)) continue
    seen.add(key)
    const guard = clean(f.guard)
    const id = `flow:${f.from}>${f.to}`
    if (guard !== "") {
      const label = `guard:${f.from}>${f.to}`
      addCell(label, "label", `[${guard}]`, cells.get(f.from)!.lane, cells.get(f.from)!.order + 0.5)
      flows.push({ id, from: f.from, to: f.to, label })
    } else flows.push({ id, from: f.from, to: f.to, label: null })
  }
  const edges: [string, string][] = flows.flatMap((f): [string, string][] => (f.label ? [[f.from, f.label], [f.label, f.to]] : [[f.from, f.to]]))
  const ids = [...cells.values()].sort((a, b) => a.order - b.order).map((c) => c.key)
  const plan = planActivity(ids, new Set(d.nodes.filter((n) => n.kind === "initial").map((n) => n.id)), edges)
  for (const c of cells.values()) c.row = plan.rank.get(c.key) ?? 0
  const rows = Math.max(0, ...[...cells.values()].map((c) => c.row)) + 1
  const backSet = new Set(plan.back.map(([a, b]) => `${a}>${b}`))
  const links: Link[] = edges.map(([from, to]) => ({ id: `seg:${from}>${to}`, from, to, back: backSet.has(`${from}>${to}`) }))
  const linksIn = (key: string): Link[] => links.filter((l) => l.to === key)

  // ── ô trong làn: số cột mỗi làn, rồi gán cột theo hàng ──
  const members = (row: number, lane: number): Cell[] => [...cells.values()].filter((c) => c.row === row && c.lane === lane)
  const slotsOf = lanes.map((_, lane) => Math.max(1, ...Array.from({ length: rows }, (_, row) => members(row, lane).length)))
  const laneStart = slotsOf.map((_, i) => slotsOf.slice(0, i).reduce((a, b) => a + b, 0))
  for (let row = 0; row < rows; row++) {
    for (let lane = 0; lane < lanes.length; lane++) {
      const free = new Set(Array.from({ length: slotsOf[lane] }, (_, i) => i))
      const desired = (c: Cell): number => {
        const cols = linksIn(c.key)
          .filter((l) => !l.back)
          .map((l) => cells.get(l.from)!)
          .filter((p) => p.col >= 0)
          .map((p) => p.col)
        const raw = cols.length === 0 ? 0 : cols.reduce((a, b) => a + b, 0) / cols.length - laneStart[lane]
        return Math.min(slotsOf[lane] - 1, Math.max(0, Math.round(raw)))
      }
      const wanted = members(row, lane)
        .map((c) => ({ c, d: desired(c) }))
        .sort((a, b) => a.d - b.d || a.c.order - b.c.order)
      for (const { c, d: want } of wanted) {
        const slot = [...free].sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0]
        free.delete(slot)
        c.slot = slot
        c.col = laneStart[lane] + slot
      }
    }
  }
  const grid = new Map([...cells.values()].map((c) => [`${c.col}:${c.row}`, c]))
  const at = (col: number, row: number): Cell | undefined => grid.get(`${col}:${row}`)

  // ── đường thẳng: cạnh tiến cùng cột, không ô nào chắn ──
  const isStraight = (l: Link): boolean => {
    if (l.back) return false
    const u = cells.get(l.from)!
    const v = cells.get(l.to)!
    if (u.col !== v.col) return false
    for (let r = u.row + 1; r < v.row; r++) if (at(u.col, r)) return false
    return true
  }
  const straight = new Set(links.filter(isStraight).map((l) => l.id))

  // ── cổng: nhóm cổng dùng chung khoảng dọc trong một khe (đầu ra của ô trên + đầu vào của ô ngay dưới cùng cột) ──
  const groupOf = (key: string, side: "out" | "in"): string => {
    if (side === "out") return `B:${key}`
    const c = cells.get(key)!
    const above = at(c.col, c.row - 1)
    return above ? `B:${above.key}` : `T:${key}`
  }
  const groups = new Map<string, { link: Link; other: number }[]>()
  const groupCells = new Map<string, Set<string>>()
  for (const l of links) {
    const u = cells.get(l.from)!
    const v = cells.get(l.to)!
    for (const [key, side, other] of [[l.from, "out", v.col + (l.back ? 0.5 : 0)], [l.to, "in", u.col + (l.back ? 0.5 : 0)]] as const) {
      const g = groupOf(key, side)
      const list = groups.get(g) ?? []
      if (!list.some((i) => i.link.id === l.id)) list.push({ link: l, other })
      groups.set(g, list)
      groupCells.set(g, (groupCells.get(g) ?? new Set()).add(key))
    }
  }
  const portOffset = new Map<string, number>()
  for (const [g, items] of groups) {
    items.sort((a, b) => a.other - b.other || (a.link.id < b.link.id ? -1 : 1))
    const s = items.findIndex((i) => straight.has(i.link.id))
    const centre = s >= 0 ? s : (items.length - 1) / 2
    const span = Math.min(...[...groupCells.get(g)!].map((k) => cells.get(k)!.span))
    const reach = Math.max(centre, items.length - 1 - centre)
    const step = reach > 0 ? Math.min(PORT_STEP, span / reach) : PORT_STEP
    items.forEach((item, i) => {
      const off = (i - centre) * step
      const l = item.link
      if (groupOf(l.from, "out") === g) portOffset.set(`${l.id}:out`, off)
      if (groupOf(l.to, "in") === g) portOffset.set(`${l.id}:in`, off)
    })
  }

  // ── rãnh: chọn rãnh cho đường Z kép và vòng lặp, đếm số đường để nới ──
  const gutterIndex = (lane: number, j: number): number => laneStart[lane] + lane + j
  const laneOfCol = (col: number): number => laneStart.findIndex((s, i) => col >= s && col < s + slotsOf[i])
  const nominalColX = (col: number): number => (col + laneOfCol(col)) * (CELL_W + GUTTER_MIN) + GUTTER_MIN + CELL_W / 2
  const nominalGutters: number[] = []
  for (let lane = 0; lane < lanes.length; lane++) for (let j = 0; j <= slotsOf[lane]; j++) nominalGutters.push(gutterIndex(lane, j) * (CELL_W + GUTTER_MIN) + GUTTER_MIN / 2)
  const gutterOf = new Map<string, number>()
  for (const l of links) {
    if (straight.has(l.id)) continue
    const u = cells.get(l.from)!
    const v = cells.get(l.to)!
    if (!l.back && v.row === u.row + 1) continue
    // Vòng lặp đi bên phải của cột xa hơn (thường là rãnh ngoài) — tránh cắt ngang luồng chính
    const mid = l.back ? Math.max(nominalColX(u.col), nominalColX(v.col)) + CELL_W / 2 : (nominalColX(u.col) + nominalColX(v.col)) / 2
    let best = 0
    nominalGutters.forEach((x, g) => {
      if (Math.abs(x - mid) < Math.abs(nominalGutters[best] - mid)) best = g
    })
    gutterOf.set(l.id, best)
  }
  const tracks = new Map<number, string[]>()
  for (const [id, g] of [...gutterOf].sort(([a], [b]) => (a < b ? -1 : 1))) tracks.set(g, [...(tracks.get(g) ?? []), id])

  // ── hoành độ ──
  const gutterW = nominalGutters.map((_, g) => Math.max(GUTTER_MIN, 2 * GUTTER_PAD + (tracks.get(g)?.length ?? 0) * TRACK_GAP))
  const headLines = lanes.map((l, i) => (l.name === "" ? [] : wrapLines(clean(l.name), HEAD_SIZE, Math.max(120, slotsOf[i] * (CELL_W + GUTTER_MIN) - 28), 2)))
  const laneWidth = (lane: number): number => {
    let w = 0
    for (let j = 0; j <= slotsOf[lane]; j++) w += gutterW[gutterIndex(lane, j)]
    return w + slotsOf[lane] * CELL_W
  }
  const slackLeft = lanes.map((_, lane) => {
    const need = Math.max(0, ...headLines[lane].map((line) => textWidth(line, HEAD_SIZE, true) + 28))
    return Math.max(0, need - laneWidth(lane)) / 2
  })
  const gutterLeft: number[] = []
  const colLeft: number[] = []
  const laneX: number[] = []
  let x = 0
  for (let lane = 0; lane < lanes.length; lane++) {
    laneX.push(x)
    x += slackLeft[lane]
    for (let j = 0; j <= slotsOf[lane]; j++) {
      gutterLeft[gutterIndex(lane, j)] = x
      x += gutterW[gutterIndex(lane, j)]
      if (j < slotsOf[lane]) {
        colLeft[laneStart[lane] + j] = x
        x += CELL_W
      }
    }
    x += slackLeft[lane]
  }
  const laneRight = lanes.map((_, lane) => (lane + 1 < lanes.length ? laneX[lane + 1] : x))
  const centreX = (col: number): number => colLeft[col] + CELL_W / 2
  const gutterTrackX = (g: number, id: string): number => gutterLeft[g] + GUTTER_PAD + (tracks.get(g)!.indexOf(id) + 0.5) * TRACK_GAP
  const portX = (l: Link, side: "out" | "in"): number => centreX(cells.get(side === "out" ? l.from : l.to)!.col) + (portOffset.get(`${l.id}:${side}`) ?? 0)

  // ── khe: khe g nằm trên hàng g (khe 0 trên cùng, khe `rows` dưới cùng); mỗi đoạn ngang một tung độ riêng ──
  interface Run {
    link: Link
    part: 1 | 2
    from: number
    to: number
  }
  const runs: Run[][] = Array.from({ length: rows + 1 }, () => [])
  for (const l of links) {
    if (straight.has(l.id)) continue
    const u = cells.get(l.from)!
    const v = cells.get(l.to)!
    if (!l.back && v.row === u.row + 1) runs[v.row].push({ link: l, part: 1, from: portX(l, "out"), to: portX(l, "in") })
    else {
      const gx = gutterTrackX(gutterOf.get(l.id)!, l.id)
      runs[u.row + 1].push({ link: l, part: 1, from: portX(l, "out"), to: gx })
      runs[v.row].push({ link: l, part: 2, from: gx, to: portX(l, "in") })
    }
  }
  for (const list of runs) {
    list.sort((a, b) => {
      const ra = a.to > a.from ? 0 : 1
      const rb = b.to > b.from ? 0 : 1
      return ra - rb || (ra === 0 ? b.from - a.from : a.from - b.from) || (a.link.id < b.link.id ? -1 : 1)
    })
  }

  // ── tung độ ──
  const headH = named ? 12 + Math.max(...headLines.map((h) => h.length)) * HEAD_LINE : 0
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(0, ...[...cells.values()].filter((c) => c.row === r).map((c) => c.h)))
  const gapH = runs.map((list, g) => (list.length === 0 && (g === 0 || g === rows) ? EDGE_GAP_MIN : Math.max(GAP_MIN, 2 * GAP_PAD + list.length * RUN_GAP)))
  const gapTop: number[] = []
  const rowTop: number[] = []
  let y = headH
  for (let r = 0; r <= rows; r++) {
    gapTop.push(y)
    y += gapH[r]
    if (r < rows) {
      rowTop.push(y)
      y += rowH[r]
    }
  }
  const bottom = y
  const runY = (gap: number, link: Link, part: 1 | 2): number => {
    const i = runs[gap].findIndex((r) => r.link.id === link.id && r.part === part)
    return gapTop[gap] + GAP_PAD + (i + 0.5) * RUN_GAP
  }

  // ── hình của từng ô (căn giữa ô theo chiều dọc của hàng) ──
  const topOf = (c: Cell): number => rowTop[c.row] + (rowH[c.row] - c.h) / 2
  const cyOf = (c: Cell): number => topOf(c) + c.h / 2
  /** Tung độ điểm chạm viền tại độ lệch `dx` khỏi tâm, ở cạnh trên (`in`) hoặc cạnh dưới (`out`). */
  const portY = (c: Cell, dx: number, side: "out" | "in"): number => {
    const sign = side === "out" ? 1 : -1
    const cy = cyOf(c)
    switch (c.kind) {
      case "initial":
      case "final": {
        const r = c.kind === "initial" ? INIT_R : FINAL_R
        return cy + sign * Math.sqrt(Math.max(0, r * r - dx * dx))
      }
      case "decision":
      case "merge": {
        // Cạnh thoi: cao h/2 ở giữa, về 0 ở hai đỉnh trái / phải
        return cy + sign * (c.h / 2) * Math.max(0, 1 - Math.abs(dx) / (c.w / 2))
      }
      default:
        return cy + (sign * c.h) / 2
    }
  }

  // ── vẽ: làn ──
  if (named) {
    lanes.forEach((lane, i) => {
      const id = `lane:${lane.id || i}`
      scene.rect(id, laneX[i], 0, laneRight[i] - laneX[i], bottom, { name: lane.name, container: true })
      scene.rect(`${id}#head`, laneX[i], 0, laneRight[i] - laneX[i], headH, { name: lane.name })
      headLines[i].forEach((line, k) =>
        scene.text(`${id}#t${k}`, (laneX[i] + laneRight[i]) / 2, headH / 2 + (k - (headLines[i].length - 1) / 2) * HEAD_LINE, line, { owner: `${id}#head`, size: HEAD_SIZE, bold: true, baseline: "central" })
      )
    })
  }

  // ── vẽ: nút ──
  for (const c of cells.values()) {
    const cx = centreX(c.col)
    const top = topOf(c)
    const cy = cyOf(c)
    const name = c.name || c.key
    switch (c.kind) {
      case "action":
        scene.rect(c.key, cx - c.w / 2, top, c.w, c.h, { name, radius: RADIUS, fill: FILL })
        c.lines.forEach((line, i) => scene.text(`${c.key}#t${i}`, cx, cy + (i - (c.lines.length - 1) / 2) * LINE, line, { owner: c.key, size: TEXT, baseline: "central", name: line }))
        break
      case "decision":
      case "merge": {
        const pts: Point[] = [
          [cx - c.w / 2, cy],
          [cx, top],
          [cx + c.w / 2, cy],
          [cx, top + c.h]
        ]
        scene.polygon(c.key, pts, { name: c.name || (c.kind === "decision" ? "Decision" : "Merge"), fill: PAPER })
        c.lines.forEach((line, i) => scene.text(`${c.key}#t${i}`, cx, cy + (i - (c.lines.length - 1) / 2) * LINE, line, { owner: c.key, size: TEXT, baseline: "central", name: line }))
        break
      }
      case "fork":
      case "join":
        scene.rect(c.key, cx - c.w / 2, top, c.w, c.h, { name: c.kind === "fork" ? "Fork" : "Join", fill: INK })
        break
      case "initial":
        scene.circle(c.key, cx, cy, INIT_R, { name: "Initial node", fill: INK })
        break
      case "final":
        scene.circle(c.key, cx, cy, FINAL_R, { name: "Activity final", fill: PAPER })
        scene.decorationCircle(`${c.key}#core`, c.key, cx, cy, FINAL_INNER, INK)
        break
      case "label":
        break
    }
  }

  // ── vẽ: đường (mỗi flow một polyline; flow có guard đi xuyên ô nhãn của nó) ──
  const nameOf = (key: string): string => {
    const c = cells.get(key)!
    return c.name || c.kind
  }
  const segmentPoints = (l: Link): Point[] => {
    const u = cells.get(l.from)!
    const v = cells.get(l.to)!
    const xo = portX(l, "out")
    const xi = portX(l, "in")
    const startY = u.kind === "label" ? topOf(u) + u.h : portY(u, xo - centreX(u.col), "out")
    const endY = v.kind === "label" ? topOf(v) : portY(v, xi - centreX(v.col), "in")
    if (straight.has(l.id)) return [[xo, startY], [xo, endY]]
    if (!l.back && v.row === u.row + 1) {
      const yc = runY(v.row, l, 1)
      return [[xo, startY], [xo, yc], [xi, yc], [xi, endY]]
    }
    const gx = gutterTrackX(gutterOf.get(l.id)!, l.id)
    const y1 = runY(u.row + 1, l, 1)
    const y2 = runY(v.row, l, 2)
    return [[xo, startY], [xo, y1], [gx, y1], [gx, y2], [xi, y2], [xi, endY]]
  }
  const linkOf = new Map(links.map((l) => [`${l.from}>${l.to}`, l]))
  for (const f of flows) {
    let points: Point[]
    if (f.label) {
      const a = linkOf.get(`${f.from}>${f.label}`)!
      const b = linkOf.get(`${f.label}>${f.to}`)!
      const cell = cells.get(f.label)!
      const mid = cyOf(cell)
      const pa = segmentPoints(a)
      const pb = segmentPoints(b)
      points = simplify([...pa, [pa[pa.length - 1][0], mid], [pb[0][0], mid], ...pb])
    } else points = simplify(segmentPoints(linkOf.get(`${f.from}>${f.to}`)!))
    scene.polyline(f.id, points, { name: `${nameOf(f.from)} → ${nameOf(f.to)}` })
    scene.arrow(f.id, "open")
    if (f.label) {
      const cell = cells.get(f.label)!
      scene.labelBlock(f.id, cell.lines, [centreX(cell.col), cyOf(cell)], { size: LABEL_SIZE, lineHeight: LABEL_LINE })
    }
  }
  return scene
}
