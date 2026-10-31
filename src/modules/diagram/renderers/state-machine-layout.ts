/**
 * state-machine-layout.ts
 * ─────────────────────────────────────────────────────────────────
 * State machine diagram (UML 2.5) dựng bằng SVG: vòng đời của MỘT entity.
 *
 * Phần tử: chấm đặc = initial pseudostate (nối vào trạng thái `initial`); hình chữ nhật bo góc = state (tên đậm giữa);
 * vòng tròn đồng tâm (bullseye) = final state (một cái cho mỗi state `final`); mũi tên hở = transition với nhãn
 * `event [guard] / action`. Transition tự thân (`from = to`) là internal transition của UML: ghi `event [guard] / action`
 * trong ngăn dưới của chính state, không vẽ đường.
 *
 * MỌI transition là một đoạn thẳng. Bố cục: state xếp theo lớp (BFS từ initial) thành cột (hoặc hàng); nhiều ứng viên
 * bố cục (khoảng cách, hướng, cách sắp trong lớp) và cuối cùng là xếp vòng tròn (dây cung không xuyên state nào) — chọn
 * ứng viên có `checkScene` rỗng, ít đường cắt nhau nhất rồi điểm thô (độ dài, tỉ lệ khung) thấp nhất. Hai transition giữa cùng
 * một cặp state (ngược chiều hoặc khác sự kiện) là các đoạn song song lệch nhau. Nhãn đặt trên đường hoặc sát đường,
 * ở chỗ không đè state / đường / nhãn khác.
 *
 * Mọi hình tô `#7ACFF5`, viền / chữ đen; chấm initial và lõi bullseye đen (UML).
 */

import { checkScene, overlaps } from "../../../shared/diagram/svg-geometry.js"
import { arrowHeadShape, INK, PAPER, textWidth, type Point } from "../../../shared/diagram/svg-kit.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"
import { wrapLines } from "./usecase-layout.js"

export interface StateInput {
  id: string
  name: string
  initial: boolean
  final: boolean
  /** Internal transition (`event [guard] / action`) đã ghép chữ, in trong ngăn dưới của state. */
  internal: readonly string[]
}

export interface TransitionInput {
  from: string
  to: string
  /** Nhãn đã ghép `event [guard] / action`. */
  text: string
}

export interface StateMachineInput {
  states: readonly StateInput[]
  /** Không gồm transition tự thân (đã nằm trong `StateInput.internal`). */
  transitions: readonly TransitionInput[]
}

const NAME_SIZE = 14
const NAME_LINE = 18
const INTERNAL_SIZE = 12
const INTERNAL_LINE = 16
const LABEL_SIZE = 12
const LABEL_LINE = 16
const LABEL_MAX_W = 170
const STATE_MIN_W = 96
const STATE_MIN_H = 48
const STATE_RADIUS = 12
const INIT_R = 9
const FINAL_R = 12
const FINAL_INNER = 7
const MIN_EDGE = 36
const PAIR_GAP = 26

type NodeKind = "state" | "initial" | "final"

interface Node {
  key: string
  kind: NodeKind
  w: number
  h: number
  /** Chỉ state. */
  nameLines: string[]
  internalLines: string[]
  name: string
}

interface Edge {
  id: string
  from: string
  to: string
  lines: string[]
}

const stateKey = (id: string): string => `S:${id}`
const FINAL_PREFIX = "F:"
const INITIAL_KEY = "I"

const sizeState = (s: StateInput): Node => {
  const nameLines = wrapLines(s.name, NAME_SIZE, 150, 2)
  const internalLines = s.internal.flatMap((t) => wrapLines(t, INTERNAL_SIZE, 230, 3))
  const widest = Math.max(
    ...nameLines.map((l) => textWidth(l, NAME_SIZE, true) + 28),
    ...internalLines.map((l) => textWidth(l, INTERNAL_SIZE) + 24),
    STATE_MIN_W
  )
  const head = Math.max(STATE_MIN_H, nameLines.length * NAME_LINE + 16)
  const h = internalLines.length === 0 ? head : head + internalLines.length * INTERNAL_LINE + 12
  return { key: stateKey(s.id), kind: "state", w: Math.ceil(widest), h, nameLines, internalLines, name: s.name }
}

const nodeOf = (key: string, kind: NodeKind): Node => {
  const r = kind === "initial" ? INIT_R : FINAL_R
  return { key, kind, w: 2 * r, h: 2 * r, nameLines: [], internalLines: [], name: kind === "initial" ? "Initial state" : "Final state" }
}

// ─── đồ thị ──────────────────────────────────────────────────────

interface Graph {
  nodes: Node[]
  edges: Edge[]
  /** Lớp BFS của mỗi node (initial = 0). */
  layer: Map<string, number>
  /** Khoảng cách các đoạn song song của từng cặp node (khoá `pairKey`), đủ cho nhãn nhiều dòng nhất của cặp. */
  pairGap: Map<string, number>
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const buildGraph = (input: StateMachineInput): Graph => {
  const states = [...input.states].sort((a, b) => compare(a.id, b.id))
  const ids = new Set(states.map((s) => s.id))
  const nodes: Node[] = []
  const edges: Edge[] = []
  const start = states.find((s) => s.initial)
  if (start) {
    nodes.push(nodeOf(INITIAL_KEY, "initial"))
    edges.push({ id: "START", from: INITIAL_KEY, to: stateKey(start.id), lines: [] })
  }
  for (const s of states) nodes.push(sizeState(s))
  for (const s of states.filter((x) => x.final)) {
    nodes.push(nodeOf(FINAL_PREFIX + s.id, "final"))
    edges.push({ id: `END:${s.id}`, from: stateKey(s.id), to: FINAL_PREFIX + s.id, lines: [] })
  }
  const seen = new Map<string, number>()
  const sorted = [...input.transitions].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.text, b.text))
  for (const t of sorted) {
    if (t.from === t.to || !ids.has(t.from) || !ids.has(t.to)) continue
    const base = `T:${t.from}>${t.to}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    edges.push({ id: n === 1 ? base : `${base}#${n}`, from: stateKey(t.from), to: stateKey(t.to), lines: wrapLines(t.text, LABEL_SIZE, LABEL_MAX_W, 3) })
  }

  // lớp: BFS theo chiều transition từ initial; node chưa tới được xếp sau lớp cuối
  const layer = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  const queue: string[] = []
  const root = start ? INITIAL_KEY : nodes[0]?.key
  if (root) {
    layer.set(root, 0)
    queue.push(root)
  }
  for (let i = 0; i < queue.length; i++) {
    for (const next of out.get(queue[i]) ?? []) {
      if (layer.has(next)) continue
      layer.set(next, layer.get(queue[i])! + 1)
      queue.push(next)
    }
  }
  let last = Math.max(0, ...layer.values())
  for (const n of nodes) if (!layer.has(n.key)) layer.set(n.key, ++last)

  // Nhiều đoạn giữa một cặp node: các đoạn song song cách nhau đủ cho nhãn; state được nới để đoạn ngoài cùng vẫn chạm
  // vào phần thẳng của cạnh (không rơi vào góc bo)
  const groups = new Map<string, Edge[]>()
  for (const e of edges) groups.set(pairKey(e.from, e.to), [...(groups.get(pairKey(e.from, e.to)) ?? []), e])
  const pairGap = new Map<string, number>()
  for (const [key, group] of groups) {
    if (group.length < 2) continue
    const gap = Math.max(PAIR_GAP, ...group.map((e) => e.lines.length * LABEL_LINE + 10))
    pairGap.set(key, gap)
    const need = Math.ceil((group.length - 1) * gap + 2 * STATE_RADIUS + 8)
    for (const k of key.split("|")) {
      const node = nodes.find((n) => n.key === k)
      if (node?.kind === "state") {
        node.w = Math.max(node.w, need)
        node.h = Math.max(node.h, need)
      }
    }
  }
  return { nodes, edges, layer, pairGap }
}

// ─── hình học ────────────────────────────────────────────────────

type Centers = Map<string, Point>

const unit = (a: Point, b: Point): Point | null => {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  return len === 0 ? null : [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
}

/** Điểm tia `p + t·d` rời hình của `node` (tâm `c`) — hình chữ nhật hoặc hình tròn; `p` nằm trong hình. */
const exitPoint = (node: Node, c: Point, p: Point, d: Point): Point => {
  if (node.kind !== "state") {
    const r = node.w / 2
    const rel: Point = [p[0] - c[0], p[1] - c[1]]
    const b = rel[0] * d[0] + rel[1] * d[1]
    const t = -b + Math.sqrt(Math.max(b * b - (rel[0] * rel[0] + rel[1] * rel[1] - r * r), 0))
    return [p[0] + d[0] * t, p[1] + d[1] * t]
  }
  const rel: Point = [p[0] - c[0], p[1] - c[1]]
  const tx = d[0] > 0 ? (node.w / 2 - rel[0]) / d[0] : d[0] < 0 ? (-node.w / 2 - rel[0]) / d[0] : Infinity
  const ty = d[1] > 0 ? (node.h / 2 - rel[1]) / d[1] : d[1] < 0 ? (-node.h / 2 - rel[1]) / d[1] : Infinity
  const t = Math.min(tx, ty)
  return [p[0] + d[0] * t, p[1] + d[1] * t]
}

interface Segment {
  edge: Edge
  a: Point
  b: Point
}

/** Đoạn của mọi edge: cùng cặp node ⇒ các đoạn song song cách nhau `pairGap`, đối xứng quanh đường nối tâm. */
const segmentsOf = (graph: Graph, centers: Centers): Segment[] | null => {
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]))
  const groups = new Map<string, Edge[]>()
  for (const e of graph.edges) {
    const key = pairKey(e.from, e.to)
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  const out: Segment[] = []
  for (const [key, group] of groups) {
    const [lo, hi] = key.split("|")
    const cLo = centers.get(lo)
    const cHi = centers.get(hi)
    if (!cLo || !cHi) return null
    const d = unit(cLo, cHi)
    if (!d) return null
    const n: Point = [-d[1], d[0]]
    const nLo = byKey.get(lo)!
    const nHi = byKey.get(hi)!
    const gap = graph.pairGap.get(key) ?? 0
    group.forEach((edge, i) => {
      const o = (i - (group.length - 1) / 2) * gap
      const p0: Point = [cLo[0] + n[0] * o, cLo[1] + n[1] * o]
      const p1: Point = [cHi[0] + n[0] * o, cHi[1] + n[1] * o]
      const pLo = exitPoint(nLo, cLo, p0, d)
      const pHi = exitPoint(nHi, cHi, p1, [-d[0], -d[1]])
      out.push(edge.from === lo ? { edge, a: pLo, b: pHi } : { edge, a: pHi, b: pLo })
    })
  }
  const order = new Map(graph.edges.map((e, i) => [e.id, i]))
  out.sort((x, y) => order.get(x.edge.id)! - order.get(y.edge.id)!)
  return out.some((s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) < MIN_EDGE) ? null : out
}

const cross = (o: Point, a: Point, b: Point): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

/** Hai đoạn cắt nhau thật (không tính chung đầu mút). */
const intersect = (s: Segment, t: Segment): boolean => {
  const same = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1
  if (same(s.a, t.a) || same(s.a, t.b) || same(s.b, t.a) || same(s.b, t.b)) return false
  return cross(s.a, s.b, t.a) * cross(s.a, s.b, t.b) < 0 && cross(t.a, t.b, s.a) * cross(t.a, t.b, s.b) < 0
}

const countCrossings = (segs: readonly Segment[]): number => {
  let n = 0
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (intersect(segs[i], segs[j])) n++
  return n
}

// ─── nhãn ────────────────────────────────────────────────────────

const rectPoly = (cx: number, cy: number, w: number, h: number): Point[] => [
  [cx - w / 2, cy - h / 2],
  [cx + w / 2, cy - h / 2],
  [cx + w / 2, cy + h / 2],
  [cx - w / 2, cy + h / 2]
]

const distanceToSegment = (p: Point, a: Point, b: Point): number => {
  const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2))
  return Math.hypot(p[0] - (a[0] + t * (b[0] - a[0])), p[1] - (a[1] + t * (b[1] - a[1])))
}

const ALONG = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]

interface LabelSpot {
  at: Point
  /** true ⇒ một dòng quay dọc theo đường (đoạn dốc, nhiều đoạn song song), false ⇒ nhiều dòng nằm ngang. */
  rotated: boolean
}

const rotatedPoly = (at: Point, w: number, h: number, deg: number): Point[] => {
  const a = (deg * Math.PI) / 180
  return rectPoly(0, 0, w, h).map((p): Point => [at[0] + p[0] * Math.cos(a) - p[1] * Math.sin(a), at[1] + p[0] * Math.sin(a) + p[1] * Math.cos(a)])
}

/** Góc (độ) của a→b quay về (-90, 90] — như `Scene.label`, chữ luôn đứng. */
const uprightDeg = (a: Point, b: Point): number => {
  let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
  if (deg > 90) deg -= 180
  if (deg <= -90) deg += 180
  return deg
}

/** Chữ một dòng của nhãn (cho kiểu quay dọc đường). */
export const joinedLabel = (lines: readonly string[]): string => lines.join(" ")

/** Chỗ đặt nhãn cho từng edge có nhãn: nằm ngang trên / sát đường, không được thì quay dọc đường; null nếu có nhãn không còn chỗ. */
const placeLabels = (graph: Graph, centers: Centers, segs: readonly Segment[]): Map<string, LabelSpot> | null => {
  const nodeBoxes = graph.nodes.map((n) => rectPoly(centers.get(n.key)![0], centers.get(n.key)![1], n.w + 4, n.h + 4))
  const heads = segs.map((s) => arrowHeadShape("open", s.b, s.a).points as Point[])
  const placed: Point[][] = []
  const result = new Map<string, LabelSpot>()
  for (const [i, seg] of segs.entries()) {
    if (seg.edge.lines.length === 0) continue
    const d = unit(seg.a, seg.b)!
    const normal: Point = [-d[1], d[0]]
    const deg = uprightDeg(seg.a, seg.b)
    const modes = [
      { rotated: false, w: Math.max(...seg.edge.lines.map((l) => textWidth(l, LABEL_SIZE))) + 12, h: seg.edge.lines.length * LABEL_LINE + 8 },
      { rotated: true, w: textWidth(joinedLabel(seg.edge.lines), LABEL_SIZE) + 12, h: LABEL_SIZE + 8 }
    ]
    let found: LabelSpot | null = null
    for (const mode of modes) {
      const ext = mode.rotated ? mode.h / 2 + 2 : (Math.abs(normal[0]) * mode.w) / 2 + (Math.abs(normal[1]) * mode.h) / 2 + 2
      for (const side of [0, ext, -ext, ext + 12, -(ext + 12)]) {
        for (const t of ALONG) {
          const at: Point = [seg.a[0] + (seg.b[0] - seg.a[0]) * t + normal[0] * side, seg.a[1] + (seg.b[1] - seg.a[1]) * t + normal[1] * side]
          const box = mode.rotated ? rotatedPoly(at, mode.w, mode.h, deg) : rectPoly(at[0], at[1], mode.w, mode.h)
          if (nodeBoxes.some((n) => overlaps(box, n))) continue
          if (segs.some((s, k) => k !== i && overlaps(box, [s.a, s.b]))) continue
          if (heads.some((hd) => overlaps(box, hd))) continue
          if (placed.some((q) => overlaps(box, q))) continue
          // nhãn phải gần đường của nó hơn mọi đường khác
          const own = distanceToSegment(at, seg.a, seg.b)
          if (!segs.every((s, k) => k === i || distanceToSegment(at, s.a, s.b) > own + 0.5)) continue
          placed.push(box)
          found = { at, rotated: mode.rotated }
          break
        }
        if (found) break
      }
      if (found) break
    }
    if (!found) return null
    result.set(seg.edge.id, found)
  }
  return result
}

// ─── dựng Scene ──────────────────────────────────────────────────

interface Built {
  scene: Scene
  crossings: number
  /** Điểm thô (`roughCost`) — hoà số cắt nhau thì chọn hình gọn, cân đối hơn. */
  cost: number
}

const build = (graph: Graph, centers: Centers): Built | null => {
  const segs = segmentsOf(graph, centers)
  if (!segs) return null
  const labels = placeLabels(graph, centers, segs)
  if (!labels) return null
  const scene = new Scene()
  for (const s of segs) {
    scene.line(s.edge.id, s.a, s.b, { name: s.edge.lines.join(" ") || s.edge.id })
    scene.arrow(s.edge.id, "open")
  }
  for (const n of graph.nodes) {
    const [cx, cy] = centers.get(n.key)!
    if (n.kind === "initial") scene.circle(n.key, cx, cy, INIT_R, { name: n.name, fill: INK })
    else if (n.kind === "final") {
      scene.circle(n.key, cx, cy, FINAL_R, { name: n.name, fill: PAPER })
      scene.circle(`${n.key}#core`, cx, cy, FINAL_INNER, { name: n.name, fill: INK })
    } else {
      scene.rect(n.key, cx - n.w / 2, cy - n.h / 2, n.w, n.h, { name: n.name, radius: STATE_RADIUS })
      const head = n.internalLines.length === 0 ? n.h : n.h - n.internalLines.length * INTERNAL_LINE - 12
      n.nameLines.forEach((line, i) =>
        scene.text(`${n.key}#name-${i}`, cx, cy - n.h / 2 + head / 2 + (i - (n.nameLines.length - 1) / 2) * NAME_LINE, line, { size: NAME_SIZE, bold: true, baseline: "central", owner: n.key, name: line })
      )
      if (n.internalLines.length > 0) {
        const y = cy - n.h / 2 + head
        scene.decoration(`${n.key}#divider`, n.key, [[cx - n.w / 2, y], [cx + n.w / 2, y]])
        n.internalLines.forEach((line, i) =>
          scene.text(`${n.key}#internal-${i}`, cx - n.w / 2 + 12, y + 6 + INTERNAL_LINE / 2 + i * INTERNAL_LINE, line, { size: INTERNAL_SIZE, anchor: "start", baseline: "central", owner: n.key, name: line })
        )
      }
    }
  }
  for (const s of segs) {
    const spot = labels.get(s.edge.id)
    if (!spot) continue
    if (spot.rotated) scene.label(s.edge.id, joinedLabel(s.edge.lines), { size: LABEL_SIZE, at: spot.at })
    else scene.labelBlock(s.edge.id, s.edge.lines, spot.at, { size: LABEL_SIZE, lineHeight: LABEL_LINE })
  }
  return { scene, crossings: countCrossings(segs), cost: roughCost(graph, centers) }
}

// ─── ứng viên bố cục ─────────────────────────────────────────────

interface LayerOptions {
  vertical: boolean
  /** Khoảng cách giữa các lớp / trong một lớp (px, mép–mép). */
  layerGap: number
  itemGap: number
  /** Căn theo láng giềng ở lớp trước (chuỗi thẳng) hay xếp chồng giữa. */
  align: boolean
  reverse: boolean
  /** > 0 ⇒ thứ tự trong lớp theo băm có hạt giống (thử thêm các hoán vị), thay cho thứ tự theo láng giềng. */
  seed: number
}

const mix = (key: string, seed: number): number => {
  let h = 2166136261 ^ seed
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return (h >>> 0) / 4294967296
}

const layered = (graph: Graph, o: LayerOptions): Centers => {
  const maxLayer = Math.max(...graph.layer.values())
  const major = (n: Node): number => (o.vertical ? n.h : n.w)
  const minor = (n: Node): number => (o.vertical ? n.w : n.h)
  const pos = new Map<string, number>()
  const neighbours = new Map<string, string[]>()
  for (const e of graph.edges) {
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from])
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to])
  }
  const centers: Centers = new Map()
  let offset = 0
  for (let l = 0; l <= maxLayer; l++) {
    const members = graph.nodes.filter((n) => graph.layer.get(n.key) === l)
    if (members.length === 0) continue
    const desired = new Map<string, number>()
    for (const n of members) {
      const known = (neighbours.get(n.key) ?? []).filter((k) => pos.has(k) && graph.layer.get(k)! < l).map((k) => pos.get(k)!)
      desired.set(n.key, o.align && known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 0)
    }
    members.sort((a, b) => (o.seed > 0 ? mix(a.key, o.seed) - mix(b.key, o.seed) : desired.get(a.key)! - desired.get(b.key)!) || compare(a.key, b.key))
    if (o.reverse && l > 0) members.reverse()
    const placed: number[] = []
    members.forEach((n, i) => {
      const want = o.align || i === 0 ? desired.get(n.key)! : 0
      placed.push(i === 0 ? want : Math.max(want, placed[i - 1] + (minor(members[i - 1]) + minor(n)) / 2 + o.itemGap))
    })
    const slide = o.align ? members.reduce((a, n, i) => a + desired.get(n.key)! - placed[i], 0) / members.length : -(placed[0] + placed[placed.length - 1]) / 2
    const depth = Math.max(...members.map(major))
    members.forEach((n, i) => {
      const m = placed[i] + slide
      pos.set(n.key, m)
      centers.set(n.key, o.vertical ? [m, offset + depth / 2] : [offset + depth / 2, m])
    })
    offset += depth + o.layerGap
  }
  return centers
}

const circle = (graph: Graph, scale: number): Centers => {
  const order = [...graph.nodes].sort((a, b) => graph.layer.get(a.key)! - graph.layer.get(b.key)! || compare(a.key, b.key))
  const ring = order.reduce((a, n) => a + Math.max(n.w, n.h) + 90, 0)
  const r = Math.max(130, ring / (2 * Math.PI)) * scale
  const centers: Centers = new Map()
  order.forEach((n, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / order.length
    centers.set(n.key, [r * Math.cos(a), r * Math.sin(a)])
  })
  return centers
}

function* candidates(graph: Graph): Generator<Centers> {
  const wide = Math.max(...graph.edges.map((e) => Math.max(0, ...e.lines.map((l) => textWidth(l, LABEL_SIZE)))), 0)
  for (const vertical of [false, true]) {
    for (const align of [true, false]) {
      for (const reverse of [false, true]) {
        for (const gap of [0, 1, 2]) {
          const layerGap = vertical ? 70 + 40 * gap : Math.max(70, wide + 50) + 45 * gap
          for (const itemGap of [50, 90]) yield layered(graph, { vertical, layerGap, itemGap: vertical ? itemGap + wide * 0.4 : itemGap, align, reverse, seed: 0 })
        }
      }
    }
  }
  for (let seed = 1; seed <= 8; seed++) {
    for (const vertical of [false, true]) yield layered(graph, { vertical, layerGap: vertical ? 90 : Math.max(90, wide + 70), itemGap: vertical ? 60 + wide * 0.4 : 60, align: false, reverse: false, seed })
  }
  for (const scale of [1, 1.25, 1.6, 2, 2.6]) yield circle(graph, scale)
}

// ─── chọn bố cục ─────────────────────────────────────────────────

/** Điểm thô của một vị trí (không dựng nhãn): đường cắt nhau, đường xuyên node, node chồng nhau, tổng độ dài. */
const roughCost = (graph: Graph, centers: Centers): number => {
  const segs = segmentsOf(graph, centers)
  if (!segs) return Infinity
  const boxes = graph.nodes.map((n) => ({ key: n.key, box: rectPoly(centers.get(n.key)![0], centers.get(n.key)![1], n.w + 24, n.h + 24), core: rectPoly(centers.get(n.key)![0], centers.get(n.key)![1], n.w - 2, n.h - 2) }))
  let cost = countCrossings(segs) * 1000
  for (const s of segs) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1])
    cost += len * 0.2
    if (s.edge.lines.length > 0) {
      // nhãn nằm ngang: đoạn phải đủ dài cho bề rộng / chiều cao nhãn theo phương của đoạn; đoạn song song với đoạn khác
      // chỉ còn nhãn quay dọc đường, cần đủ dài cho cả dòng chữ
      const w = Math.max(...s.edge.lines.map((l) => textWidth(l, LABEL_SIZE))) + 12
      const h = s.edge.lines.length * LABEL_LINE + 8
      const along = textWidth(joinedLabel(s.edge.lines), LABEL_SIZE) + 40
      const flat = (w * Math.abs(s.b[0] - s.a[0]) + h * Math.abs(s.b[1] - s.a[1])) / len + 28
      const need = graph.pairGap.has(pairKey(s.edge.from, s.edge.to)) ? along : Math.min(flat, along)
      if (len < need) cost += (need - len) * 30
    }
    for (const b of boxes) if (b.key !== s.edge.from && b.key !== s.edge.to && overlaps([s.a, s.b], b.core)) cost += 3000
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i].box, boxes[j].box)) cost += 5000
  // hình ngang dễ đọc / chèn vào tài liệu hơn hình quá cao
  const xs = graph.nodes.flatMap((n) => [centers.get(n.key)![0] - n.w / 2, centers.get(n.key)![0] + n.w / 2])
  const ys = graph.nodes.flatMap((n) => [centers.get(n.key)![1] - n.h / 2, centers.get(n.key)![1] + n.h / 2])
  const width = Math.max(...xs) - Math.min(...xs)
  const height = Math.max(...ys) - Math.min(...ys)
  return cost + Math.abs(Math.log(width / height) - Math.log(1.6)) * 120
}

/** PRNG tất định (mulberry32). */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Điểm thô từ ngưỡng này trở lên nghĩa là còn đường cắt nhau / xuyên node / node chồng nhau — mới cần leo đồi. */
const FLAWED = 1000
const CLIMB_STEPS = 800

/** Leo đồi: đổi chỗ hai node (giữ nguyên tập vị trí) khi điểm thô giảm. */
const improve = (graph: Graph, start: Centers): Centers => {
  const keys = graph.nodes.map((n) => n.key)
  let current = new Map(start)
  let cost = roughCost(graph, current)
  const rnd = prng(keys.length * 7919 + 17)
  for (let step = 0; step < CLIMB_STEPS && cost >= FLAWED && keys.length > 2; step++) {
    const a = keys[Math.floor(rnd() * keys.length)]
    const b = keys[Math.floor(rnd() * keys.length)]
    if (a === b) continue
    const next = new Map(current)
    next.set(a, current.get(b)!)
    next.set(b, current.get(a)!)
    const c = roughCost(graph, next)
    if (c < cost) {
      current = next
      cost = c
    }
  }
  return current
}

const BEST_STARTS = 6

/** Scene của một state machine, hoặc null khi không tìm được bố cục không vi phạm. */
export const layoutStateMachine = (input: StateMachineInput): Scene | null => {
  if (input.states.length === 0) return null
  const graph = buildGraph(input)
  const starts = [...candidates(graph)]
    .map((centers) => ({ centers, cost: roughCost(graph, centers) }))
    .filter((c) => Number.isFinite(c.cost))
    .sort((a, b) => a.cost - b.cost)
  const pool = [...starts.map((c) => c.centers), ...starts.slice(0, BEST_STARTS).map((c) => improve(graph, c.centers))]
  let best: Built | null = null
  for (const centers of pool) {
    const built = build(graph, centers)
    if (!built || checkScene(built.scene, { allowBends: false }).length > 0) continue
    if (!best || built.crossings < best.crossings || (built.crossings === best.crossings && built.cost < best.cost)) best = built
  }
  return best?.scene ?? null
}
