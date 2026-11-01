/**
 * Hình học sơ đồ luồng màn — đúng ký pháp hình mẫu §3.1.1 Screens Flow của template SRS FPT
 * (`docs/technical/screen-flow-diagram-layout.md`). Đơn vị px, trục y hướng xuống (khớp `Scene`).
 *
 * Ký hiệu: màn = chữ nhật góc vuông; pop-up = ô-van; màn nhiều tab = khung chứa tên màn và một hộp con chữ nghiêng cho mỗi
 * tab. Nền `FILL` cho màn dùng chung, trắng cho màn còn lại. Mũi tên tam giác đặc, đường ngang / dọc góc nhọn, không nhãn.
 *
 * Bố cục trái → phải: cột = hạng (đường dài nhất từ màn vào). Mỗi màn có một cha trong cây (cạnh tiến từ cột liền trước,
 * thứ tự ưu tiên nhỏ nhất); hàng gán theo DFS cây: lá mở hàng mới, cha nằm cùng hàng với con đầu tiên — cây con liền khối,
 * cha và con đầu nối bằng một đoạn thẳng như template.
 *
 * Đường đi trong hai loại kênh không bao giờ có hình: rãnh dọc giữa hai cột và phố ngang giữa hai hàng.
 *   - Cạnh sang cột kế: các cạnh của cùng một màn nguồn dùng chung **một trục** (đoạn ra + đoạn dọc trong rãnh), mỗi đích
 *     một nhánh ngang có đầu mũi tên. Cạnh duy nhất tới màn cùng hàng là một đoạn thẳng.
 *   - Cạnh nhảy ≥ 2 cột: ra rãnh sau màn nguồn, đi dọc tới phố ngay dưới hàng trên của hai màn, đi ngang tới rãnh trước màn
 *     đích, đi dọc tới cổng vào.
 * Mỗi đoạn dọc trong rãnh có hoành độ riêng, mỗi đoạn ngang trong phố có tung độ riêng; cổng ra / vào trên cạnh phải / trái
 * của hình có tung độ riêng (ra phụ ở nửa trên, vào phụ ở nửa dưới) ⇒ không đoạn nào chồng đoạn khác, giao nhau chỉ vuông góc.
 */

import { FILL, PAPER, textWidth, type Point } from "../../../shared/diagram/svg-kit.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"

// ─── đồ thị: màn vào, cạnh tiến, hạng ──────────────────────────────

export interface FlowPlan {
  /** Màn vào (gốc của cây bố cục): đại diện của mỗi thành phần liên thông mạnh không có cạnh tới từ ngoài. */
  entries: string[]
  /** Cạnh tiến (không có cạnh quay lại màn trước), sắp theo thứ tự màn. */
  edges: [string, string][]
  /** Hạng = đường dài nhất từ một màn vào (= cột); mọi cạnh đi theo chiều tăng hạng. */
  rank: Map<string, number>
  /** Màn không có cạnh tiến đi ra. */
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

export interface FlowNode {
  id: string
  name: string
  popup: boolean
  tabs: readonly string[]
  /** Màn dùng chung (mọi actor người) ⇒ nền `FILL`; còn lại nền trắng. */
  shared: boolean
}
export interface FlowDiagram {
  /** Theo thứ tự ưu tiên (queue_order, id). */
  nodes: readonly FlowNode[]
  /** Cặp `[từ, tới]` theo `screens[].flow_to`. */
  edges: readonly (readonly [string, string])[]
}

const TEXT = 13
const LINE = 16
export const NODE_W = 150
const PAD_X = 10
const PAD_Y = 9
const MIN_H = 40
const TEXT_W = NODE_W - 2 * PAD_X
const MAX_LINES = 4
/** Ô-van: chữ nằm trong hình chữ nhật nội tiếp — rộng ≤ `POPUP_TEXT_W`, nửa cao ≤ `POPUP_FIT` × bán trục dọc. */
const POPUP_TEXT_W = 118
const POPUP_FIT = 0.58
const POPUP_MAX_LINES = 3
/** Khung tab: lề trong, hộp tab (chữ nghiêng), khe giữa các hộp. */
const TAB_INSET = 10
const TAB_SIZE = 12
const TAB_LINE = 15
const TAB_PAD_Y = 5
const TAB_GAP = 6
const TAB_W = NODE_W - 2 * TAB_INSET
const TAB_TEXT_W = TAB_W - 12
const FRAME_RADIUS = 14
/** Rãnh dọc giữa hai cột, phố ngang giữa hai hàng: lề hai bên + một track mỗi đường. */
const GUTTER_PAD = 18
const GUTTER_MIN = 56
const STREET_PAD = 8
const STREET_MIN = 22
const TRACK = 10
const MARGIN = 12
/** Bước giữa hai cổng kề nhau trên một cạnh: rộng hơn đầu mũi tên (`triangle_filled` rộng 9) ⇒ hai đầu mũi tên không chạm. */
const PORT_STEP = 12
const HEAD_HALF = 4.5
const PORT_EDGE = 4
/** Ô-van: cổng chỉ nằm trên cung giữa, độ lệch ≤ `POPUP_PORT_SPAN` × chiều cao. */
const POPUP_PORT_SPAN = 0.3

const clean = (text: string): string => text.replace(/\s+/g, " ").trim()

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

/** Gói `text` tối đa `maxLines` dòng ≤ `max` px; dư thì dòng cuối kết thúc bằng `...`. */
const wrapCapped = (text: string, size: number, max: number, maxLines: number): string[] => {
  const lines: string[] = []
  for (const word of breakLongWords(text, size, max).split(/\s+/).filter((w) => w !== "")) {
    const last = lines.length - 1
    if (last >= 0 && textWidth(`${lines[last]} ${word}`, size) <= max) lines[last] = `${lines[last]} ${word}`
    else lines.push(word)
  }
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = fit(`${kept[maxLines - 1]} ...`, size, max)
  return kept
}

type Kind = "screen" | "popup" | "tabs"
interface Placed {
  node: FlowNode
  kind: Kind
  lines: string[]
  /** Dòng chữ của từng hộp tab (chỉ `tabs`). */
  tabLines: string[][]
  h: number
  col: number
  row: number
  order: number
}

const measure = (n: FlowNode, order: number): Placed => {
  const name = clean(n.name) || n.id
  const tabs = n.tabs.map(clean).filter((t) => t !== "")
  if (tabs.length > 0) {
    const lines = wrapCapped(name, TEXT, TEXT_W, MAX_LINES)
    const tabLines = tabs.map((t) => wrapCapped(t, TAB_SIZE, TAB_TEXT_W, 2))
    const h = PAD_Y + lines.length * LINE + tabLines.reduce((a, l) => a + TAB_GAP + l.length * TAB_LINE + 2 * TAB_PAD_Y, 0) + PAD_Y + 2
    return { node: n, kind: "tabs", lines, tabLines, h, col: 0, row: 0, order }
  }
  if (n.popup) {
    const lines = wrapCapped(name, TEXT, POPUP_TEXT_W, POPUP_MAX_LINES)
    const ry = Math.max(MIN_H / 2 + 2, ((lines.length * LINE) / 2 + 1) / POPUP_FIT)
    return { node: n, kind: "popup", lines, tabLines: [], h: 2 * ry, col: 0, row: 0, order }
  }
  const lines = wrapCapped(name, TEXT, TEXT_W, MAX_LINES)
  return { node: n, kind: "screen", lines, tabLines: [], h: Math.max(MIN_H, lines.length * LINE + 2 * PAD_Y), col: 0, row: 0, order }
}

/**
 * Chiều cao tối thiểu để `steps` bước cổng về mỗi phía của tâm nằm trên phần cạnh thẳng (khung bo góc: trừ góc bo) hoặc
 * trên cung giữa của ô-van, đầu mũi tên (nửa rộng `HEAD_HALF`) không chạm góc.
 */
const heightForPorts = (p: Placed, steps: number): number => {
  if (steps === 0) return 0
  if (p.kind === "popup") return (steps * PORT_STEP) / POPUP_PORT_SPAN
  return 2 * (steps * PORT_STEP + HEAD_HALF + PORT_EDGE + (p.kind === "tabs" && p.node.popup ? FRAME_RADIUS : 0))
}

/** Khoảng lùi vào so với cạnh bao tại độ lệch `dy` (ô-van: cổng nằm trên cung). */
const inset = (p: Placed, dy: number): number => {
  if (p.kind !== "popup") return 0
  const rx = NODE_W / 2
  const ry = p.h / 2
  return rx - rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2))
}

/** Dãy bậc cổng: `start` (0 hoặc 1) rồi lùi dần theo `sign` — độ lệch = bậc × `PORT_STEP`. */
const steps = (count: number, start: number, sign: 1 | -1): number[] => Array.from({ length: count }, (_, i) => sign * (start + i))

interface Route {
  id: string
  from: string
  to: string
  kind: "straight" | "branch" | "far"
}

export const layoutScreenFlow = (d: FlowDiagram): Scene => {
  const scene = new Scene()
  const order = new Map(d.nodes.map((n, i) => [n.id, i]))
  const plan = planFlow(
    d.nodes.map((n) => n.id),
    new Set(d.nodes.filter((n) => n.popup).map((n) => n.id)),
    d.edges.map(([a, b]): [string, string] => [a, b])
  )
  const placed = new Map(d.nodes.map((n, i) => [n.id, measure(n, i)]))
  for (const p of placed.values()) p.col = plan.rank.get(p.node.id)!

  // ── cây: cha = nguồn ở cột liền trước có thứ tự nhỏ nhất; hàng theo DFS ──
  const parent = new Map<string, string>()
  for (const [from, to] of plan.edges) {
    if (plan.rank.get(from)! + 1 !== plan.rank.get(to)!) continue
    const had = parent.get(to)
    if (had === undefined || order.get(from)! < order.get(had)!) parent.set(to, from)
  }
  const children = new Map<string, string[]>(d.nodes.map((n) => [n.id, []]))
  for (const n of d.nodes) {
    const p = parent.get(n.id)
    if (p !== undefined) children.get(p)!.push(n.id)
  }
  let rows = 0
  const assign = (id: string): number => {
    const kids = children.get(id)!
    const rowsOfKids = kids.map(assign)
    const row = rowsOfKids.length > 0 ? rowsOfKids[0] : rows++
    placed.get(id)!.row = row
    return row
  }
  for (const n of d.nodes) if (!parent.has(n.id)) assign(n.id)

  const cols = Math.max(0, ...[...placed.values()].map((p) => p.col)) + 1


  // ── phân loại đường ──
  const routes: Route[] = []
  const adjacentOut = new Map<string, string[]>()
  for (const [from, to] of plan.edges) {
    const u = placed.get(from)!
    const v = placed.get(to)!
    if (v.col !== u.col + 1) {
      routes.push({ id: `flow:${from}>${to}`, from, to, kind: "far" })
      continue
    }
    adjacentOut.set(from, [...(adjacentOut.get(from) ?? []), to])
  }
  for (const [from, targets] of adjacentOut) {
    const u = placed.get(from)!
    const lone = targets.length === 1 && placed.get(targets[0])!.row === u.row
    for (const to of targets) routes.push({ id: `flow:${from}>${to}`, from, to, kind: lone ? "straight" : "branch" })
  }
  /** Màn nguồn có trục chung (≥ 1 cạnh sang cột kế không thẳng hàng). */
  const buses = [...adjacentOut.keys()].filter((from) => routes.some((r) => r.from === from && r.kind === "branch"))

  // ── cổng: ra chính ở tâm (trục chung / đường thẳng), ra phụ nửa trên; vào thẳng hàng ở tâm, vào phụ nửa dưới ──
  const outY = new Map<string, number>()
  const inY = new Map<string, number>()
  for (const p of placed.values()) {
    const id = p.node.id
    const mine = routes.filter((r) => r.from === id)
    const hasMain = mine.some((r) => r.kind !== "far")
    const fars = mine.filter((r) => r.kind === "far").sort((a, b) => placed.get(a.to)!.row - placed.get(b.to)!.row || order.get(a.to)! - order.get(b.to)!)
    for (const r of mine) if (r.kind !== "far") outY.set(r.id, 0)
    steps(fars.length, hasMain ? 1 : 0, -1).forEach((k, i) => outY.set(fars[i].id, k * PORT_STEP))

    const incoming = routes.filter((r) => r.to === id)
    const main = incoming.filter((r) => placed.get(r.from)!.row === p.row && r.kind !== "far")
    const rest = incoming.filter((r) => !main.includes(r)).sort((a, b) => placed.get(a.from)!.row - placed.get(b.from)!.row || placed.get(a.from)!.col - placed.get(b.from)!.col || order.get(a.from)! - order.get(b.from)!)
    for (const r of main) inY.set(r.id, 0)
    steps(rest.length, main.length > 0 ? 1 : 0, 1).forEach((k, i) => inY.set(rest[i].id, k * PORT_STEP))
    // Hình cao thêm khi cần chỗ cho cổng (không nén bước: đầu mũi tên kề nhau sẽ chạm)
    const used = Math.max(0, ...[...mine, ...incoming].map((r) => Math.abs((r.from === id ? outY.get(r.id) : inY.get(r.id)) ?? 0) / PORT_STEP))
    p.h = Math.max(p.h, heightForPorts(p, used))
  }

  // ── track trong rãnh (g = rãnh sau cột g) và phố (k = phố trên hàng k; k = rows là dưới hàng cuối) ──
  const gutterTracks: string[][] = Array.from({ length: Math.max(0, cols - 1) }, () => [])
  for (const from of [...buses].sort((a, b) => placed.get(a)!.row - placed.get(b)!.row)) gutterTracks[placed.get(from)!.col].push(`bus:${from}`)
  const fars = routes.filter((r) => r.kind === "far")
  for (const r of fars) gutterTracks[placed.get(r.from)!.col].push(`${r.id}@out`)
  for (const r of fars) gutterTracks[placed.get(r.to)!.col - 1].push(`${r.id}@in`)
  const streetTracks: string[][] = Array.from({ length: rows + 1 }, () => [])
  const streetOf = (r: Route): number => Math.min(placed.get(r.from)!.row, placed.get(r.to)!.row) + 1
  for (const r of fars) streetTracks[streetOf(r)].push(r.id)

  // ── toạ độ ──
  const gutterW = gutterTracks.map((t) => Math.max(GUTTER_MIN, 2 * GUTTER_PAD + t.length * TRACK))
  const colLeft: number[] = []
  let x = MARGIN
  for (let c = 0; c < cols; c++) {
    colLeft.push(x)
    x += NODE_W + (c < cols - 1 ? gutterW[c] : 0)
  }
  const trackX = (key: string, g: number): number => colLeft[g] + NODE_W + GUTTER_PAD + (gutterTracks[g].indexOf(key) + 0.5) * TRACK

  const rowH = Array.from({ length: rows }, (_, r) => Math.max(MIN_H, ...[...placed.values()].filter((p) => p.row === r).map((p) => p.h)))
  const streetH = streetTracks.map((t, k) => (k === 0 || k === rows ? (t.length === 0 ? 0 : 2 * STREET_PAD + t.length * TRACK) : Math.max(STREET_MIN, 2 * STREET_PAD + t.length * TRACK)))
  const rowTop: number[] = []
  const streetTop: number[] = []
  let y = MARGIN
  for (let r = 0; r <= rows; r++) {
    streetTop.push(y)
    y += streetH[r]
    if (r < rows) {
      rowTop.push(y)
      y += rowH[r]
    }
  }
  const streetY = (r: Route): number => {
    const k = streetOf(r)
    return streetTop[k] + STREET_PAD + (streetTracks[k].indexOf(r.id) + 0.5) * TRACK
  }
  const cy = (p: Placed): number => rowTop[p.row] + rowH[p.row] / 2
  const left = (p: Placed): number => colLeft[p.col]
  const right = (p: Placed): number => colLeft[p.col] + NODE_W

  // ── vẽ: hình ──
  for (const p of placed.values()) {
    const id = p.node.id
    const name = clean(p.node.name) || id
    const fill = p.node.shared ? FILL : PAPER
    const top = cy(p) - p.h / 2
    const cx = left(p) + NODE_W / 2
    if (p.kind === "popup") {
      scene.ellipse(id, cx, cy(p), NODE_W / 2, p.h / 2, { name, fill })
      p.lines.forEach((line, i) => scene.text(`${id}#t${i}`, cx, cy(p) + (i - (p.lines.length - 1) / 2) * LINE, line, { owner: id, size: TEXT, baseline: "central", name: line }))
    } else if (p.kind === "screen") {
      scene.rect(id, left(p), top, NODE_W, p.h, { name, fill })
      p.lines.forEach((line, i) => scene.text(`${id}#t${i}`, cx, cy(p) + (i - (p.lines.length - 1) / 2) * LINE, line, { owner: id, size: TEXT, baseline: "central", name: line }))
    } else {
      scene.rect(id, left(p), top, NODE_W, p.h, { name, fill, container: true, radius: p.node.popup ? FRAME_RADIUS : 0 })
      p.lines.forEach((line, i) => scene.text(`${id}#t${i}`, cx, top + PAD_Y + (i + 0.5) * LINE, line, { owner: id, size: TEXT, baseline: "central", name: line }))
      let ty = top + PAD_Y + p.lines.length * LINE
      p.tabLines.forEach((lines, k) => {
        ty += TAB_GAP
        const th = lines.length * TAB_LINE + 2 * TAB_PAD_Y
        const tabId = `${id}#tab${k}`
        scene.rect(tabId, cx - TAB_W / 2, ty, TAB_W, th, { name: lines.join(" "), fill: PAPER })
        lines.forEach((line, i) => scene.text(`${tabId}#t${i}`, cx, ty + TAB_PAD_Y + (i + 0.5) * TAB_LINE, line, { owner: tabId, size: TAB_SIZE, italic: true, baseline: "central", name: line }))
        ty += th
      })
    }
  }

  // ── vẽ: đường ──
  const nameOf = (id: string): string => clean(placed.get(id)!.node.name) || id
  const outPoint = (r: Route): Point => {
    const u = placed.get(r.from)!
    const dy = outY.get(r.id) ?? 0
    return [right(u) - inset(u, dy), cy(u) + dy]
  }
  const inPoint = (r: Route): Point => {
    const v = placed.get(r.to)!
    const dy = inY.get(r.id) ?? 0
    return [left(v) + inset(v, dy), cy(v) + dy]
  }
  for (const from of buses) {
    const u = placed.get(from)!
    const xt = trackX(`bus:${from}`, u.col)
    const start = outPoint(routes.find((r) => r.from === from && r.kind === "branch")!)
    scene.polyline(`bus:${from}`, [start, [xt, start[1]]], { name: `${nameOf(from)} →` })
    const ys = [start[1], ...routes.filter((r) => r.from === from && r.kind === "branch").map((r) => inPoint(r)[1])]
    const lo = Math.min(...ys)
    const hi = Math.max(...ys)
    if (hi - lo > 0.5) scene.polyline(`bus:${from}#trunk`, [[xt, lo], [xt, hi]], { name: `${nameOf(from)} →` })
  }
  for (const r of routes) {
    const name = `${nameOf(r.from)} → ${nameOf(r.to)}`
    const end = inPoint(r)
    let points: Point[]
    if (r.kind === "straight") points = [outPoint(r), end]
    else if (r.kind === "branch") points = [[trackX(`bus:${r.from}`, placed.get(r.from)!.col), end[1]], end]
    else {
      const start = outPoint(r)
      const x1 = trackX(`${r.id}@out`, placed.get(r.from)!.col)
      const x2 = trackX(`${r.id}@in`, placed.get(r.to)!.col - 1)
      const ys = streetY(r)
      points = [start, [x1, start[1]], [x1, ys], [x2, ys], [x2, end[1]], end]
    }
    scene.polyline(r.id, points, { name })
    scene.arrow(r.id, "triangle_filled")
  }

  return scene
}
