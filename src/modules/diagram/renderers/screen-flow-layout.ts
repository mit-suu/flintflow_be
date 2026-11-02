/**
 * Hình học sơ đồ luồng màn — đúng ký pháp hình mẫu §3.1.1 Screens Flow của template SRS FPT
 * (`docs/technical/screen-flow-diagram-layout.md`). Đơn vị px, trục y hướng xuống (khớp `Scene`).
 *
 * Ký hiệu: màn = chữ nhật góc vuông; pop-up = ô-van; màn nhiều tab = khung chứa tên màn và một hộp con chữ nghiêng cho mỗi
 * tab. Nền `FILL` cho màn dùng chung, trắng cho màn còn lại. Mũi tên tam giác đặc, đường ngang / dọc góc nhọn, không nhãn.
 *
 * Bố cục trái → phải theo cây (`flowTree`): cha của màn = màn phát hiện ra nó khi BFS từ màn vào (đường vào nông nhất),
 * cột = độ sâu ⇒ con ở cột ngay sau cha. Hàng gán theo DFS cây: lá mở hàng mới, cha nằm cùng hàng với con đầu tiên — cây
 * con liền khối, cha và con đầu nối bằng một đoạn thẳng như template.
 *
 * CHỈ VẼ CÂY: mỗi màn một đường vào từ màn cha, cộng mọi cạnh mở pop-up. Lối vào khác vẫn ở `flow_to` nhưng không vẽ —
 * cạnh chéo làm hình rối khi nhiều màn.
 *
 * Đường đi trong hai loại kênh không bao giờ có hình: rãnh dọc giữa hai cột và phố ngang giữa hai hàng. Mỗi màn có một lối
 * ra ở tâm cạnh phải: cạnh thẳng duy nhất tới màn cùng hàng ở cột kế, hoặc một trục chung (đoạn ra + đoạn dọc trong rãnh)
 * mà mọi đường của màn đó rẽ ra — nhánh ngang tới màn ở cột kế, hoặc đường xa (pop-up không ở cột kế) đi ngang trong phố
 * cạnh hàng đích tới trục thu trong rãnh trước đích. Đường xa vào cùng màn từ cùng phía gộp một trục thu, chung một mũi tên.
 * Mỗi đoạn dọc có hoành độ riêng, mỗi đoạn ngang trong phố có tung độ riêng, cổng vào có tung độ riêng ⇒ không đoạn nào
 * chồng đoạn khác, giao nhau chỉ vuông góc. Chi tiết: `docs/technical/screen-flow-diagram-layout.md` (thư mục workspace).
 */

import { FILL, PAPER, textWidth, type Point } from "../../../shared/diagram/svg-kit.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"

// ─── đồ thị: màn vào, cạnh tiến, hạng ──────────────────────────────

export interface FlowPlan {
  /** Màn vào (gốc của cây bố cục): đại diện của mỗi thành phần liên thông mạnh không có cạnh tới từ ngoài. */
  entries: string[]
  /** Cạnh tiến (không có cạnh quay lại màn trước), sắp theo thứ tự màn. */
  edges: [string, string][]
  /** Hạng = đường dài nhất từ một màn vào; mọi cạnh đi theo chiều tăng hạng (dùng khi tách đôi; cột của hình là độ sâu `flowTree`). */
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

export interface FlowTree {
  /** Cha của màn trong cây bố cục (màn vào không có cha). */
  parent: Map<string, string>
  /** Cột = độ sâu từ màn vào; con luôn ở cột ngay sau cha. */
  depth: Map<string, number>
}

/**
 * Cây bố cục: BFS từ các màn vào theo cạnh tiến (thứ tự màn), cha = màn phát hiện ra nó — đường vào nông nhất, hoà thì
 * màn đứng trước. Hạng đường dài nhất đẩy cả nhánh sang phải chỉ vì một liên kết chéo; độ sâu giữ cây gọn như template.
 */
export const flowTree = (plan: FlowPlan): FlowTree => {
  const outs = new Map<string, string[]>()
  for (const [from, to] of plan.edges) outs.set(from, [...(outs.get(from) ?? []), to])
  const parent = new Map<string, string>()
  const depth = new Map(plan.entries.map((id) => [id, 0]))
  const queue = [...plan.entries]
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i]
    for (const to of outs.get(from) ?? []) {
      if (depth.has(to)) continue
      depth.set(to, depth.get(from)! + 1)
      parent.set(to, from)
      queue.push(to)
    }
  }
  for (const id of plan.rank.keys()) if (!depth.has(id)) depth.set(id, 0)
  return { parent, depth }
}

/** Số cột của hình luồng màn `d` — để renderer tách hình quá rộng. */
export const flowColumns = (d: FlowDiagram): number => {
  const plan = planFlow(d.nodes.map((n) => n.id), new Set(d.nodes.filter((n) => n.popup).map((n) => n.id)), d.edges)
  return Math.max(0, ...flowTree(plan).depth.values()) + 1
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

/** Phía đường xa đi vào màn đích: từ phố ngay trên hàng đích (`up`) hay ngay dưới (`down`). */
type Side = "up" | "down"

export const layoutScreenFlow = (d: FlowDiagram): Scene => {
  const scene = new Scene()
  const order = new Map(d.nodes.map((n, i) => [n.id, i]))
  const plan = planFlow(
    d.nodes.map((n) => n.id),
    new Set(d.nodes.filter((n) => n.popup).map((n) => n.id)),
    d.edges.map(([a, b]): [string, string] => [a, b])
  )
  const placed = new Map(d.nodes.map((n, i) => [n.id, measure(n, i)]))
  const outs = new Map<string, string[]>(d.nodes.map((n) => [n.id, []]))
  for (const [from, to] of plan.edges) outs.get(from)!.push(to)

  // ── cột = độ sâu trong cây bố cục (`flowTree`) ──
  const { parent, depth } = flowTree(plan)
  for (const p of placed.values()) p.col = depth.get(p.node.id) ?? 0

  // ── hàng theo DFS cây: lá mở hàng mới, cha cùng hàng con đầu ──
  const children = new Map<string, string[]>(d.nodes.map((n) => [n.id, []]))
  for (const n of d.nodes) {
    const p = parent.get(n.id)
    if (p !== undefined) children.get(p)!.push(n.id)
  }
  let rows = 0
  const assign = (id: string): number => {
    const rowsOfKids = children.get(id)!.map(assign)
    const row = rowsOfKids.length > 0 ? rowsOfKids[0] : rows++
    placed.get(id)!.row = row
    return row
  }
  for (const n of d.nodes) if (!parent.has(n.id)) assign(n.id)

  const cols = Math.max(0, ...[...placed.values()].map((p) => p.col)) + 1

  // ── phân loại đường: cột kế = nhánh của trục chung; còn lại (nhảy cột, cùng cột, quay về cột trước) = đường xa ──
  // Chỉ vẽ cây: mỗi màn một đường vào từ màn cha; pop-up thêm mọi màn mở nó. Lối vào khác vẫn nằm trong `flow_to`
  // (truy vết, mô tả) nhưng không vẽ — hình mẫu template vẽ luồng chính, cạnh chéo làm hình rối khi nhiều màn.
  const routes: Route[] = []
  for (const [from, all] of outs) {
    const tree = all.filter((to) => parent.get(to) === from || placed.get(to)!.node.popup)
    // Màn gốc mà mọi đích đều đã có cha khác (vd Onboarding → Dashboard, Dashboard mở từ Login) sẽ trơ trọi ⇒ giữ đường đầu
    const targets = tree.length === 0 && !parent.has(from) && all.length > 0 ? [all[0]] : tree
    const u = placed.get(from)!
    const lone = targets.length === 1 && placed.get(targets[0])!.col === u.col + 1 && placed.get(targets[0])!.row === u.row
    for (const to of targets) {
      const kind = lone ? "straight" : placed.get(to)!.col === u.col + 1 ? "branch" : "far"
      routes.push({ id: `flow:${from}>${to}`, from, to, kind })
    }
  }
  /** Mỗi màn nguồn có đúng một lối ra: cạnh thẳng duy nhất, hoặc một trục chung cho mọi cạnh (kể cả đường xa). */
  const buses = d.nodes.map((n) => n.id).filter((id) => routes.some((r) => r.from === id && r.kind !== "straight"))
  const fars = routes.filter((r) => r.kind === "far")
  const sideOf = (r: Route): Side => (placed.get(r.from)!.row < placed.get(r.to)!.row ? "up" : "down")
  /** Phố của đường xa: ngay trên hàng đích khi đi xuống, ngay dưới khi đi lên / cùng hàng ⇒ đoạn dọc nằm trên trục của nguồn. */
  const streetOf = (r: Route): number => placed.get(r.to)!.row + (sideOf(r) === "up" ? 0 : 1)
  /** Các đường xa vào cùng một màn từ cùng một phía gộp vào một trục thu, chung một mũi tên. */
  const collectors = new Map<string, Route[]>()
  for (const r of fars) {
    const key = `${r.to}:${sideOf(r)}`
    collectors.set(key, [...(collectors.get(key) ?? []), r])
  }

  // ── cổng vào (cạnh trái): trục thu phía trên, các nhánh / cạnh thẳng, trục thu phía dưới; ra luôn ở tâm ──
  const inY = new Map<string, number>()
  for (const p of placed.values()) {
    const id = p.node.id
    const near = routes
      .filter((r) => r.to === id && r.kind !== "far")
      .sort((a, b) => placed.get(a.from)!.row - placed.get(b.from)!.row || order.get(a.from)! - order.get(b.from)!)
    const slots = [
      ...(collectors.has(`${id}:up`) ? [`collect:${id}:up`] : []),
      ...near.map((r) => r.id),
      ...(collectors.has(`${id}:down`) ? [`collect:${id}:down`] : [])
    ]
    const straight = slots.findIndex((k) => routes.some((r) => r.id === k && r.kind === "straight"))
    const center = straight >= 0 ? straight : (slots.length - 1) / 2
    slots.forEach((k, i) => inY.set(k, (i - center) * PORT_STEP))
    // Hình cao thêm khi cần chỗ cho cổng (không nén bước: đầu mũi tên kề nhau sẽ chạm)
    const used = Math.max(0, ...slots.map((k) => Math.abs(inY.get(k)!) / PORT_STEP))
    p.h = Math.max(p.h, heightForPorts(p, Math.ceil(used - 1e-9)))
  }

  // ── track trong rãnh (g = rãnh sau cột g; -1 = trước cột đầu, cols-1 = sau cột cuối — chỉ có khi đường xa cần):
  //    trục chung bên trái, trục thu bên phải (sát đích) ──
  const gutterTracks = new Map<number, string[]>(Array.from({ length: cols + 1 }, (_, i) => [i - 1, []]))
  for (const from of [...buses].sort((a, b) => placed.get(a)!.row - placed.get(b)!.row)) gutterTracks.get(placed.get(from)!.col)!.push(`bus:${from}`)
  const collectorKeys = [...collectors.keys()].sort((a, b) => placed.get(a.split(":")[0])!.row - placed.get(b.split(":")[0])!.row || (a < b ? -1 : 1))
  for (const key of collectorKeys) gutterTracks.get(placed.get(key.split(":")[0])!.col - 1)!.push(`collect:${key}`)
  const streetTracks: string[][] = Array.from({ length: rows + 1 }, () => [])
  for (const r of fars) streetTracks[streetOf(r)].push(r.id)

  // ── toạ độ ──
  const gutterW = (g: number): number => {
    const n = gutterTracks.get(g)?.length ?? 0
    return g === -1 || g === cols - 1 ? (n === 0 ? 0 : 2 * GUTTER_PAD + n * TRACK) : Math.max(GUTTER_MIN, 2 * GUTTER_PAD + n * TRACK)
  }
  const colLeft: number[] = []
  let x = MARGIN + gutterW(-1)
  for (let c = 0; c < cols; c++) {
    colLeft.push(x)
    x += NODE_W + gutterW(c)
  }
  const gutterLeft = (g: number): number => (g === -1 ? MARGIN : colLeft[g] + NODE_W)
  const trackX = (key: string, g: number): number => gutterLeft(g) + GUTTER_PAD + (gutterTracks.get(g)!.indexOf(key) + 0.5) * TRACK

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
  const outPoint = (from: string): Point => {
    const u = placed.get(from)!
    return [right(u) - inset(u, 0), cy(u)]
  }
  const inPoint = (slot: string, to: string): Point => {
    const v = placed.get(to)!
    const dy = inY.get(slot) ?? 0
    return [left(v) + inset(v, dy), cy(v) + dy]
  }
  const busX = (from: string): number => trackX(`bus:${from}`, placed.get(from)!.col)
  const collectorX = (key: string): number => trackX(`collect:${key}`, placed.get(key.split(":")[0])!.col - 1)
  const collectorOf = (r: Route): string => `${r.to}:${sideOf(r)}`
  /** Cổng vào của một đường: đường xa vào qua cổng của trục thu. */
  const slotOf = (r: Route): string => (r.kind === "far" ? `collect:${collectorOf(r)}` : r.id)

  for (const from of buses) {
    const xt = busX(from)
    const start = outPoint(from)
    scene.polyline(`bus:${from}`, [start, [xt, start[1]]], { name: `${nameOf(from)} →` })
    const ys = [start[1], ...routes.filter((r) => r.from === from).map((r) => (r.kind === "far" ? streetY(r) : inPoint(slotOf(r), r.to)[1]))]
    const lo = Math.min(...ys)
    const hi = Math.max(...ys)
    if (hi - lo > 0.5) scene.polyline(`bus:${from}#trunk`, [[xt, lo], [xt, hi]], { name: `${nameOf(from)} →` })
  }
  for (const r of routes) {
    const name = `${nameOf(r.from)} → ${nameOf(r.to)}`
    const end = inPoint(slotOf(r), r.to)
    if (r.kind === "straight") {
      scene.polyline(r.id, [outPoint(r.from), end], { name })
      scene.arrow(r.id, "triangle_filled")
    } else if (r.kind === "branch") {
      scene.polyline(r.id, [[busX(r.from), end[1]], end], { name })
      scene.arrow(r.id, "triangle_filled")
    } else {
      // Từ trục của nguồn, đi ngang trong phố cạnh hàng đích tới trục thu trong rãnh trước màn đích
      const ys = streetY(r)
      const xc = collectorX(collectorOf(r))
      if (collectors.get(collectorOf(r))!.length > 1) scene.polyline(r.id, [[busX(r.from), ys], [xc, ys]], { name })
      else {
        scene.polyline(r.id, [[busX(r.from), ys], [xc, ys], [xc, end[1]], end], { name })
        scene.arrow(r.id, "triangle_filled")
      }
    }
  }
  for (const [key, members] of collectors) {
    if (members.length < 2) continue
    const to = key.split(":")[0]
    const end = inPoint(`collect:${key}`, to)
    const xc = collectorX(key)
    const ys = [end[1], ...members.map(streetY)]
    const name = `→ ${nameOf(to)}`
    scene.polyline(`collect:${key}#trunk`, [[xc, Math.min(...ys)], [xc, Math.max(...ys)]], { name })
    scene.polyline(`collect:${key}`, [[xc, end[1]], end], { name })
    scene.arrow(`collect:${key}`, "triangle_filled")
  }

  return scene
}
