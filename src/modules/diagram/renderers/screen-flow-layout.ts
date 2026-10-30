/**
 * Hình học sơ đồ luồng màn — UML 2.5 Activity Diagram có swimlane (`docs/technical/screen-flow-diagram-layout.md`).
 * Đơn vị px, trục y hướng xuống (khớp `Scene`). Làn (ActivityPartition) kẻ dọc, mỗi làn một cột các ô; luồng đi từ trên
 * xuống: hàng 0 là các initial node, hàng cuối là các activity final, giữa là các màn xếp theo hạng (đường dài nhất từ
 * màn vào).
 *
 * Đường nối chỉ có ba dạng, đều song song trục:
 *   - thẳng đứng: cùng cột, không có ô nào chắn giữa;
 *   - chữ Z: màn ở hàng kề, một đoạn ngang trong khe giữa hai hàng;
 *   - chữ Z kép: màn xa hơn một hàng, đi xuống dọc một đường rãnh (gutter) giữa các cột — rãnh không bao giờ có ô nên
 *     đường không xuyên hình.
 * Không đoạn nào chồng lên đoạn khác: mỗi đoạn ngang có tung độ riêng trong khe, mỗi đoạn dọc trong rãnh có hoành độ
 * riêng, và các cổng (port) ở cạnh trên / cạnh dưới ô có hoành độ riêng trong từng nhóm cổng kề nhau. Các đường cắt
 * nhau chỉ ở góc vuông. Khe và rãnh tự nới theo số đường đi qua — chỗ để nhãn trigger / hình thoi rẽ nhánh về sau.
 */

import { textWidth, INK, PAPER, stereotype, type Point } from "../../../shared/diagram/svg-kit.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"
import { wrapLines } from "./usecase-layout.js"

// ─── đồ thị: màn vào, cạnh tiến, hạng ──────────────────────────────

export interface FlowPlan {
  /** Màn vào (mỗi màn một initial node): đại diện của mỗi thành phần liên thông mạnh không có cạnh tới từ ngoài. */
  entries: string[]
  /** Cạnh tiến (không có cạnh quay lại màn trước), sắp theo thứ tự màn. */
  edges: [string, string][]
  /** Hạng = đường dài nhất từ một màn vào; mọi cạnh đi xuống đúng chiều tăng hạng. */
  rank: Map<string, number>
  /** Màn không có cạnh tiến đi ra — mỗi màn một activity final. */
  sinks: string[]
}

/**
 * Lập kế hoạch luồng cho các màn `ids` (đã sắp theo thứ tự ưu tiên: queue_order rồi id). Cạnh trỏ ra ngoài `ids`, tự
 * trỏ và trùng lặp bị bỏ. Cạnh quay ngược (đóng vòng khi đi từ màn vào) không vẽ: điều hướng quay lại là ngầm định —
 * cặp màn trỏ qua lại chỉ còn chiều đi tiếp từ màn vào.
 */
export const planFlow = (ids: readonly string[], popups: ReadonlySet<string>, flows: readonly (readonly [string, string])[]): FlowPlan => {
  const index = new Map(ids.map((id, i) => [id, i]))
  const next = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [from, to] of flows) {
    if (from === to || !index.has(from) || !index.has(to) || next.get(from)!.includes(to)) continue
    next.get(from)!.push(to)
  }
  for (const targets of next.values()) targets.sort((a, b) => index.get(a)! - index.get(b)!)

  // Tarjan: thành phần liên thông mạnh
  const order = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const scc = new Map<string, number>()
  let counter = 0
  let sccCount = 0
  const strong = (id: string): void => {
    order.set(id, counter)
    low.set(id, counter)
    counter++
    stack.push(id)
    onStack.add(id)
    for (const to of next.get(id)!) {
      if (!order.has(to)) {
        strong(to)
        low.set(id, Math.min(low.get(id)!, low.get(to)!))
      } else if (onStack.has(to)) low.set(id, Math.min(low.get(id)!, order.get(to)!))
    }
    if (low.get(id) === order.get(id)) {
      for (;;) {
        const member = stack.pop()!
        onStack.delete(member)
        scc.set(member, sccCount)
        if (member === id) break
      }
      sccCount++
    }
  }
  for (const id of ids) if (!order.has(id)) strong(id)

  const hasOuterIncoming = new Set<number>()
  for (const [from, targets] of next) for (const to of targets) if (scc.get(from) !== scc.get(to)) hasOuterIncoming.add(scc.get(to)!)
  const entries: string[] = []
  for (let c = 0; c < sccCount; c++) {
    if (hasOuterIncoming.has(c)) continue
    const members = ids.filter((id) => scc.get(id) === c)
    entries.push(members.find((id) => !popups.has(id)) ?? members[0])
  }
  entries.sort((a, b) => index.get(a)! - index.get(b)!)

  // DFS từ các màn vào: cạnh tới nút đang mở là cạnh quay lại
  const state = new Map<string, 1 | 2>()
  const kept: [string, string][] = []
  const finished: string[] = []
  const walk = (id: string): void => {
    state.set(id, 1)
    for (const to of next.get(id)!) {
      if (state.get(to) === 1) continue
      kept.push([id, to])
      if (!state.has(to)) walk(to)
    }
    state.set(id, 2)
    finished.push(id)
  }
  for (const entry of entries) if (!state.has(entry)) walk(entry)

  const rank = new Map<string, number>(ids.map((id) => [id, 0]))
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [from, to] of kept) preds.get(to)!.push(from)
  for (const id of [...finished].reverse()) rank.set(id, Math.max(0, ...preds.get(id)!.map((p) => rank.get(p)! + 1)))

  const hasOut = new Set(kept.map(([from]) => from))
  const edges = kept.sort((a, b) => index.get(a[0])! - index.get(b[0])! || index.get(a[1])! - index.get(b[1])!)
  return { entries, edges, rank, sinks: ids.filter((id) => !hasOut.has(id)) }
}

// ─── hình học ──────────────────────────────────────────────────────

export interface FlowLane {
  id: string
  /** Tên actor; rỗng ⇒ chưa có làn (không vẽ khung làn). */
  name: string
}
export interface FlowNode {
  id: string
  name: string
  /** Chỉ số làn trong `lanes`. */
  lane: number
  popup: boolean
  tabs: readonly string[]
}
export interface FlowDiagram {
  lanes: readonly FlowLane[]
  /** Theo thứ tự ưu tiên (queue_order, id). */
  nodes: readonly FlowNode[]
  edges: readonly (readonly [string, string])[]
  /** Chữ stereotype của màn pop-up (`pop-up`). */
  popupLabel: string
}

const TEXT = 13
const LINE = 16
export const NODE_W = 176
const NODE_MIN_H = 44
const NODE_PAD_X = 14
const NODE_PAD_Y = 10
const RADIUS = 10
const TEXT_W = NODE_W - 2 * NODE_PAD_X
const INIT_R = 10
const FINAL_R = 12
const FINAL_INNER = 7
const HEAD_SIZE = 14
const HEAD_LINE = 18
const GUTTER_PAD = 14
const TRACK_GAP = 12
const GUTTER_MIN = 30
const GAP_PAD = 20
const RUN_GAP = 12
const GAP_MIN = 46
const TOP_PAD = 26
const BOTTOM_PAD = 26
const PORT_STEP = 14
const PORT_SPAN = NODE_W / 2 - 16

const fit = (line: string, size: number, max: number): string => {
  if (textWidth(line, size) <= max) return line
  let cut = line
  while (cut.length > 1 && textWidth(`${cut}...`, size) > max) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}...`
}
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

/** Gói dòng tham lam: mỗi dòng ≤ `max` px (từ dài đã cắt trước bởi `breakLongWords`). */
const wrapGreedy = (text: string, size: number, max: number): string[] => {
  const lines: string[] = []
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    const last = lines.length - 1
    if (last >= 0 && textWidth(`${lines[last]} ${word}`, size) <= max) lines[last] = `${lines[last]} ${word}`
    else lines.push(word)
  }
  return lines
}

/** Dòng `[tab | tab]`: ngắt dòng giữa các tab (mỗi dòng ≤ `max` px), tên tab quá dài thì gói dòng. */
const tabLines = (tabs: readonly string[], size: number, max: number): string[] => {
  const names = tabs.map(clean).filter((t) => t !== "")
  const lines: string[] = []
  let current = ""
  names.forEach((name, i) => {
    const piece = `${i === 0 ? "[" : ""}${name}${i === names.length - 1 ? "]" : " |"}`
    if (textWidth(piece, size) > max) {
      if (current !== "") lines.push(current)
      lines.push(...wrapGreedy(breakLongWords(piece, size, max), size, max))
      current = ""
    } else if (current !== "" && textWidth(`${current} ${piece}`, size) > max) {
      lines.push(current)
      current = piece
    } else current = current === "" ? piece : `${current} ${piece}`
  })
  if (current !== "") lines.push(current)
  return lines.map((l) => fit(l, size, max))
}
const clean = (text: string): string => text.replace(/\s+/g, " ").trim()

type Kind = "screen" | "initial" | "final"
interface Placed {
  key: string
  kind: Kind
  name: string
  row: number
  lane: number
  slot: number
  col: number
  lines: string[]
  h: number
  /** Chỉ số thứ tự ưu tiên (màn), hoặc của màn gắn kèm (initial / final). */
  order: number
}
interface Link {
  id: string
  from: string
  to: string
}
interface PortItem {
  link: Link
  other: number
}

export const layoutScreenFlow = (d: FlowDiagram): Scene => {
  const scene = new Scene()
  const lanes: FlowLane[] = d.lanes.length > 0 ? [...d.lanes] : [{ id: "", name: "" }]
  const named = lanes.some((l) => l.name !== "")
  const nodes = new Map(d.nodes.map((n) => [n.id, n]))
  const order = new Map(d.nodes.map((n, i) => [n.id, i]))
  const plan = planFlow(d.nodes.map((n) => n.id), new Set(d.nodes.filter((n) => n.popup).map((n) => n.id)), d.edges)
  const maxRank = Math.max(0, ...plan.rank.values())
  const initialRow = 0
  const finalRow = maxRank + 2
  const rows = finalRow + 1

  // ── nút ──
  const placed = new Map<string, Placed>()
  const add = (p: Omit<Placed, "slot" | "col">): void => void placed.set(p.key, { ...p, slot: -1, col: -1 })
  for (const n of d.nodes) {
    const lines = [
      ...(n.popup ? [stereotype(d.popupLabel)] : []),
      ...wrapGreedy(breakLongWords(clean(n.name) || n.id, TEXT, TEXT_W), TEXT, TEXT_W).map((l) => fit(l, TEXT, TEXT_W)),
      ...tabLines(n.tabs, TEXT, TEXT_W)
    ]
    add({ key: n.id, kind: "screen", name: n.name, row: plan.rank.get(n.id)! + 1, lane: n.lane, lines, h: Math.max(NODE_MIN_H, lines.length * LINE + 2 * NODE_PAD_Y), order: order.get(n.id)! })
  }
  for (const id of plan.entries) add({ key: `initial:${id}`, kind: "initial", name: "Initial", row: initialRow, lane: nodes.get(id)!.lane, lines: [], h: 2 * INIT_R, order: order.get(id)! })
  for (const id of plan.sinks) add({ key: `final:${id}`, kind: "final", name: "Final", row: finalRow, lane: nodes.get(id)!.lane, lines: [], h: 2 * FINAL_R, order: order.get(id)! })

  // ── liên kết ──
  const links: Link[] = [
    ...plan.entries.map((id) => ({ id: `start:${id}`, from: `initial:${id}`, to: id })),
    ...plan.edges.map(([from, to]) => ({ id: `flow:${from}>${to}`, from, to })),
    ...plan.sinks.map((id) => ({ id: `end:${id}`, from: id, to: `final:${id}` }))
  ]
  const parentsOf = (key: string): string[] => links.filter((l) => l.to === key).map((l) => l.from)

  // ── ô trong làn: số cột mỗi làn, rồi gán cột theo hàng ──
  const members = (row: number, lane: number): Placed[] => [...placed.values()].filter((p) => p.row === row && p.lane === lane)
  const slotsOf = lanes.map((_, lane) => Math.max(1, ...Array.from({ length: rows }, (_, row) => members(row, lane).length)))
  const laneStart = slotsOf.map((_, i) => slotsOf.slice(0, i).reduce((a, b) => a + b, 0))
  const assign = (p: Placed, slot: number): void => {
    p.slot = slot
    p.col = laneStart[p.lane] + slot
  }
  const place = (row: number, desired: (p: Placed) => number): void => {
    for (let lane = 0; lane < lanes.length; lane++) {
      const free = new Set(Array.from({ length: slotsOf[lane] }, (_, i) => i))
      const wanted = members(row, lane)
        .map((p) => ({ p, d: Math.min(slotsOf[lane] - 1, Math.max(0, Math.round(desired(p)))) }))
        .sort((a, b) => a.d - b.d || a.p.order - b.p.order)
      for (const { p, d: want } of wanted) {
        const slot = [...free].sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0]
        free.delete(slot)
        assign(p, slot)
      }
    }
  }
  const fromParents = (p: Placed): number => {
    const cols = parentsOf(p.key).map((k) => placed.get(k)!.col)
    return cols.length === 0 ? 0 : cols.reduce((a, b) => a + b, 0) / cols.length - laneStart[p.lane]
  }
  for (let row = 1; row < finalRow; row++) place(row, fromParents)
  place(initialRow, (p) => placed.get(p.key.slice("initial:".length))!.slot)
  place(finalRow, (p) => placed.get(p.key.slice("final:".length))!.slot)

  const cell = new Map([...placed.values()].map((p) => [`${p.col}:${p.row}`, p.key]))
  const at = (col: number, row: number): Placed | undefined => placed.get(cell.get(`${col}:${row}`) ?? "")

  // ── phân loại đường: thẳng / Z / Z kép ──
  const isStraight = (l: Link): boolean => {
    const u = placed.get(l.from)!
    const v = placed.get(l.to)!
    if (u.col !== v.col) return false
    for (let r = u.row + 1; r < v.row; r++) if (at(u.col, r)) return false
    return true
  }
  const straight = new Set(links.filter(isStraight).map((l) => l.id))

  // ── cổng: hoành độ riêng trong từng nhóm cổng kề nhau ──
  const groupOf = (key: string, side: "out" | "in"): string => {
    if (side === "out") return `B:${key}`
    const p = placed.get(key)!
    const above = at(p.col, p.row - 1)
    return above ? `B:${above.key}` : `T:${key}`
  }
  const groups = new Map<string, PortItem[]>()
  const colX = (col: number): number => col
  for (const l of links) {
    const u = placed.get(l.from)!
    const v = placed.get(l.to)!
    for (const [key, side, other] of [[l.from, "out", v.col], [l.to, "in", u.col]] as const) {
      const g = groupOf(key, side)
      const list = groups.get(g) ?? []
      if (!list.some((i) => i.link.id === l.id)) list.push({ link: l, other: colX(other) })
      groups.set(g, list)
    }
  }
  // Một cạnh có thể ở hai nhóm (đầu ra của ô trên, đầu vào của ô dưới): độ lệch theo (cạnh, bên)
  const portOffset = new Map<string, number>()
  for (const [g, items] of groups) {
    items.sort((a, b) => a.other - b.other || (a.link.id < b.link.id ? -1 : 1))
    const s = items.findIndex((i) => straight.has(i.link.id))
    const centre = s >= 0 ? s : (items.length - 1) / 2
    const step = Math.min(PORT_STEP, items.length > 1 ? PORT_SPAN / Math.max(centre, items.length - 1 - centre) : PORT_STEP)
    items.forEach((item, i) => {
      const off = (i - centre) * step
      const l = item.link
      if (groupOf(l.from, "out") === g) portOffset.set(`${l.id}:out`, off)
      if (groupOf(l.to, "in") === g) portOffset.set(`${l.id}:in`, off)
    })
  }

  // ── rãnh và khe: chọn rãnh cho đường Z kép, đếm số đường để nới ──
  /** Chỉ số rãnh toàn cục của rãnh `j` của làn `lane` (j = 0..slots). */
  const gutterIndex = (lane: number, j: number): number => laneStart[lane] + lane + j
  const nominalColX = (col: number, lane: number): number => (col + lane) * (NODE_W + GUTTER_MIN) + GUTTER_MIN + NODE_W / 2
  const laneOfCol = (col: number): number => laneStart.findIndex((s, i) => col >= s && col < s + slotsOf[i])
  const gutterOf = new Map<string, number>()
  const nominalGutters: number[] = []
  for (let lane = 0; lane < lanes.length; lane++)
    for (let j = 0; j <= slotsOf[lane]; j++) nominalGutters.push((laneStart[lane] + lane + j) * (NODE_W + GUTTER_MIN) + GUTTER_MIN / 2)
  for (const l of links) {
    if (straight.has(l.id)) continue
    const u = placed.get(l.from)!
    const v = placed.get(l.to)!
    if (v.row === u.row + 1) continue
    const mid = (nominalColX(u.col, laneOfCol(u.col)) + nominalColX(v.col, laneOfCol(v.col))) / 2
    let best = 0
    nominalGutters.forEach((x, g) => {
      if (Math.abs(x - mid) < Math.abs(nominalGutters[best] - mid)) best = g
    })
    gutterOf.set(l.id, best)
  }
  const tracks = new Map<number, string[]>()
  for (const [id, g] of [...gutterOf].sort(([a], [b]) => (a < b ? -1 : 1))) tracks.set(g, [...(tracks.get(g) ?? []), id])

  // ── hoành độ thật ──
  const gutterW = nominalGutters.map((_, g) => Math.max(GUTTER_MIN, 2 * GUTTER_PAD + (tracks.get(g)?.length ?? 0) * TRACK_GAP))
  const headLines = lanes.map((l) => (l.name === "" ? [] : wrapLines(clean(l.name), HEAD_SIZE, Math.max(120, slotsOf[lanes.indexOf(l)] * (NODE_W + GUTTER_MIN) - 28), 2)))
  const laneWidth = (lane: number): number => {
    let w = 0
    for (let j = 0; j <= slotsOf[lane]; j++) w += gutterW[gutterIndex(lane, j)]
    return w + slotsOf[lane] * NODE_W
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
        x += NODE_W
      }
    }
    x += slackLeft[lane]
  }
  const laneRight = lanes.map((_, lane) => (lane + 1 < lanes.length ? laneX[lane + 1] : x))
  const centreX = (col: number): number => colLeft[col] + NODE_W / 2
  const gutterTrackX = (g: number, id: string): number => gutterLeft[g] + GUTTER_PAD + (tracks.get(g)!.indexOf(id) + 0.5) * TRACK_GAP

  // ── khe giữa các hàng: số đoạn ngang ──
  interface Run {
    link: Link
    part: 1 | 2
    from: number
    to: number
  }
  const portX = (l: Link, side: "out" | "in"): number => {
    const p = placed.get(side === "out" ? l.from : l.to)!
    return centreX(p.col) + (portOffset.get(`${l.id}:${side}`) ?? 0)
  }
  const runs: Run[][] = Array.from({ length: rows - 1 }, () => [])
  for (const l of links) {
    if (straight.has(l.id)) continue
    const u = placed.get(l.from)!
    const v = placed.get(l.to)!
    if (v.row === u.row + 1) runs[u.row].push({ link: l, part: 1, from: portX(l, "out"), to: portX(l, "in") })
    else {
      const gx = gutterTrackX(gutterOf.get(l.id)!, l.id)
      runs[u.row].push({ link: l, part: 1, from: portX(l, "out"), to: gx })
      runs[v.row - 1].push({ link: l, part: 2, from: gx, to: portX(l, "in") })
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
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(0, ...[...placed.values()].filter((p) => p.row === r).map((p) => p.h)))
  const gapH = runs.map((list) => Math.max(GAP_MIN, 2 * GAP_PAD + list.length * RUN_GAP))
  const rowTop: number[] = []
  let y = headH + TOP_PAD
  for (let r = 0; r < rows; r++) {
    rowTop.push(y)
    y += rowH[r] + (r < rows - 1 ? gapH[r] : 0)
  }
  const bottom = y + BOTTOM_PAD
  const runY = (row: number, link: Link, part: 1 | 2): number => {
    const i = runs[row].findIndex((r) => r.link.id === link.id && r.part === part)
    return rowTop[row] + rowH[row] + GAP_PAD + (i + 0.5) * RUN_GAP
  }

  // ── vẽ: làn ──
  if (named) {
    lanes.forEach((lane, i) => {
      const id = `lane:${lane.id}`
      scene.rect(id, laneX[i], 0, laneRight[i] - laneX[i], bottom, { name: lane.name, container: true })
      scene.rect(`${id}#head`, laneX[i], 0, laneRight[i] - laneX[i], headH, { name: lane.name })
      headLines[i].forEach((line, k) =>
        scene.text(`${id}#t${k}`, (laneX[i] + laneRight[i]) / 2, headH / 2 + (k - (headLines[i].length - 1) / 2) * HEAD_LINE, line, { owner: `${id}#head`, size: HEAD_SIZE, bold: true, baseline: "central" })
      )
    })
  }

  // ── vẽ: nút ──
  const geometry = (p: Placed) => ({ cx: centreX(p.col), top: rowTop[p.row], bottom: rowTop[p.row] + p.h })
  for (const p of placed.values()) {
    const g = geometry(p)
    if (p.kind === "screen") {
      scene.rect(p.key, g.cx - NODE_W / 2, g.top, NODE_W, p.h, { name: clean(p.name) || p.key, radius: RADIUS })
      p.lines.forEach((line, i) =>
        scene.text(`${p.key}#t${i}`, g.cx, g.top + p.h / 2 + (i - (p.lines.length - 1) / 2) * LINE, line, { owner: p.key, size: TEXT, baseline: "central", name: line })
      )
    } else if (p.kind === "initial") {
      scene.circle(p.key, g.cx, g.top + INIT_R, INIT_R, { name: "Initial node", fill: INK })
    } else {
      scene.circle(p.key, g.cx, g.top + FINAL_R, FINAL_R, { name: "Activity final", fill: PAPER })
      scene.circle(`${p.key}#core`, g.cx, g.top + FINAL_R, FINAL_INNER, { name: "Activity final", fill: INK })
    }
  }

  // ── vẽ: đường ──
  const nameOf = (key: string): string => {
    const p = placed.get(key)!
    return p.kind === "screen" ? clean(p.name) || key : p.name
  }
  for (const l of links) {
    const u = placed.get(l.from)!
    const v = placed.get(l.to)!
    const startY = geometry(u).bottom
    const endY = geometry(v).bottom - v.h
    const xo = portX(l, "out")
    const xi = portX(l, "in")
    let points: Point[]
    if (straight.has(l.id)) points = [[xo, startY], [xo, endY]]
    else if (v.row === u.row + 1) {
      const yc = runY(u.row, l, 1)
      points = [[xo, startY], [xo, yc], [xi, yc], [xi, endY]]
    } else {
      const gx = gutterTrackX(gutterOf.get(l.id)!, l.id)
      const y1 = runY(u.row, l, 1)
      const y2 = runY(v.row - 1, l, 2)
      points = [[xo, startY], [xo, y1], [gx, y1], [gx, y2], [xi, y2], [xi, endY]]
    }
    scene.polyline(l.id, points, { name: `${nameOf(l.from)} → ${nameOf(l.to)}` })
    scene.arrow(l.id, "open")
  }
  return scene
}
