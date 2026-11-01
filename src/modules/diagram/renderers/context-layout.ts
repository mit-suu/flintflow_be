/**
 * Hình học sơ đồ ngữ cảnh (DFD mức 0, ký pháp Yourdon/DeMarco) — port từ `docs/diagram_guideline/context/build-context-diagram.mjs`.
 * Đơn vị px, trục y hướng xuống (khớp `Scene`). Hệ thống là MỘT vòng tròn ở gốc toạ độ; actor nằm trên một ellipse
 * quanh nó: người dùng nửa trái, hệ thống ngoài + bộ hẹn giờ nửa phải (một nửa trống ⇒ chia đôi danh sách).
 *
 * Mỗi luồng dữ liệu là MỘT đoạn thẳng song song trục actor–tâm, cách các luồng cùng actor `FLOW_GAP`, nên các luồng
 * của một actor không bao giờ cắt nhau. Hai chùm luồng của hai actor kề nhau được tách bằng góc (`anglesFor`).
 * Bán kính ellipse tự nới tới khi hình không còn vi phạm: đoạn đủ dài cho nhãn, hộp không chồng nhau / vòng tròn,
 * không hai đường cắt hoặc sát nhau, nhãn không đè đường / hộp / nhãn khác.
 */

import { overlaps } from "../../../shared/diagram/svg-geometry.js"
import { arrowHeadShape, textWidth, type Point } from "../../../shared/diagram/svg-kit.js"

export type { Point }
export type ActorKind = "human" | "system" | "time"
export type FlowDirection = "in" | "out"
export type ContextSide = "left" | "right"

export interface ContextActor {
  id: string
  name: string
  kind: ActorKind
  /** actor → hệ thống */
  inbound: readonly string[]
  /** hệ thống → actor */
  outbound: readonly string[]
}
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export interface PlacedActor extends ContextActor {
  box: Box
  /** Tên đã gói dòng, vẽ giữa hộp. */
  lines: string[]
  side: ContextSide
}
export interface ContextEdge {
  actorId: string
  flow: FlowDirection
  /** Vị trí trong danh sách cùng chiều (`inbound` hoặc `outbound`). */
  index: number
  text: string
  /** Đuôi mũi tên. */
  from: Point
  /** Đầu mũi tên. */
  to: Point
}
export interface ContextLayout {
  circle: { cx: number; cy: number; r: number; lines: string[] }
  actors: PlacedActor[]
  edges: ContextEdge[]
}

export const NAME_SIZE = 15
export const LABEL_SIZE = 13
/** Khoảng cách dòng của tên nhiều dòng (hộp và vòng tròn). */
export const NAME_LINE_HEIGHT = 18

const R_MIN = 110
const FLOW_GAP = 22
const BUNDLE_GAP = 24
const SPAN = (70 * Math.PI) / 180
const SPAN_MAX = (85 * Math.PI) / 180
const ENT_H = 54
const ENT_MIN_W = 150
const NAME_WRAP = 22
const SYSTEM_WRAP = 18
/** Bề rộng nền nhãn = chữ + lề; đoạn thẳng còn chừa chỗ cho đầu mũi tên hai đầu. */
const LABEL_PAD = 8
const LABEL_H = LABEL_SIZE + 4
const LABEL_ROOM = 30
const BOX_GAP = 12
const SEGMENT_GAP = 8
const CIRCLE_CLEARANCE = 20
const GROW_STEP = 1.08
const GROW_MAX = 45

/** Gói dòng chỉ đổi cách trình bày: một nhãn vẫn là một mũi tên. */
export const contextLabelLines = (text: string, limit = NAME_WRAP): string[] => {
  const lines: string[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1
    if (last >= 0 && lines[last].length + word.length + 1 <= limit) lines[last] += ` ${word}`
    else lines.push(word)
  }
  return lines.length ? lines : [""]
}

interface Flow {
  dir: FlowDirection
  index: number
  text: string
}
interface Prepared {
  actor: ContextActor
  lines: string[]
  flows: Flow[]
  w: number
  h: number
}

const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0)

const prepare = (actor: ContextActor): Prepared => {
  const lines = contextLabelLines(actor.name)
  const flows: Flow[] = [
    ...actor.inbound.map((text, index): Flow => ({ dir: "in", index, text })),
    ...actor.outbound.map((text, index): Flow => ({ dir: "out", index, text }))
  ]
  const nameW = Math.max(...lines.map((l) => textWidth(l, NAME_SIZE, true)))
  return {
    actor,
    lines,
    flows,
    w: Math.ceil(Math.max(ENT_MIN_W, nameW + 30)),
    h: Math.max(ENT_H, (Math.max(flows.length, 1) - 1) * FLOW_GAP + 28, lines.length * NAME_LINE_HEIGHT + 16)
  }
}

/** Người dùng bên trái, còn lại bên phải; một nửa trống ⇒ chia đôi danh sách (giữ thứ tự) cho cân. */
const splitSides = (actors: readonly Prepared[]): { left: Prepared[]; right: Prepared[] } => {
  const left = actors.filter((p) => p.actor.kind === "human")
  const right = actors.filter((p) => p.actor.kind !== "human")
  if (left.length === 0 && right.length > 1) {
    const half = Math.ceil(right.length / 2)
    return { left: right.slice(0, half), right: right.slice(half) }
  }
  if (right.length === 0 && left.length > 1) {
    const half = Math.ceil(left.length / 2)
    return { left: left.slice(0, half), right: left.slice(half) }
  }
  return { left, right }
}

/** Độ rộng chùm luồng của actor (khoảng cách hai luồng ngoài cùng). */
const bundleWidth = (p: Prepared): number => Math.max(0, p.flows.length - 1) * FLOW_GAP
/** Khoảng (px) trên vòng tròn giữa tâm chùm của hai actor kề nhau, để hai chùm không chạm nhau. */
const clearances = (group: readonly Prepared[]): number[] =>
  group.slice(1).map((p, i) => (bundleWidth(p) + bundleWidth(group[i])) / 2 + BUNDLE_GAP)

/**
 * Góc (rad, toạ độ màn hình) của các actor trong một nửa, từ trên xuống: hai actor kề nhau cách đủ để chùm luồng
 * không chạm ở vòng tròn; góc dư chia đều tới ±SPAN.
 */
const anglesFor = (group: readonly Prepared[], side: ContextSide, radius: number): number[] => {
  if (group.length === 1) return [side === "left" ? Math.PI : 0]
  const need = clearances(group).map((px) => px / radius)
  const total = sum(need)
  const gaps = total < 2 * SPAN ? need.map((g) => g + (2 * SPAN - total) / need.length) : need
  let t = -sum(gaps) / 2
  return group.map((_, i) => {
    if (i > 0) t += gaps[i - 1]
    return side === "left" ? Math.PI - t : t
  })
}

/** Tia p + u·t vào hộp: [t vào, t ra] hoặc null nếu trượt. */
const rayThroughBox = (p: Point, u: Point, b: Box): [number, number] | null => {
  let lo = -Infinity
  let hi = Infinity
  for (const [pa, ua, min, max] of [[p[0], u[0], b.x, b.x + b.w], [p[1], u[1], b.y, b.y + b.h]]) {
    if (Math.abs(ua) < 1e-9) {
      if (pa < min || pa > max) return null
      continue
    }
    const t1 = (min - pa) / ua
    const t2 = (max - pa) / ua
    lo = Math.max(lo, Math.min(t1, t2))
    hi = Math.min(hi, Math.max(t1, t2))
  }
  return lo <= hi ? [lo, hi] : null
}

interface Geometry {
  edge: ContextEdge
  owner: number
  /** Nền nhãn (đa giác đã quay) — null khi luồng không có nhãn. */
  label: Point[] | null
  head: Point[]
  length: number
  needed: number
}

/** Hộp chữ nhật tâm c, quay `deg` độ quanh c. */
const rotatedRect = (c: Point, w: number, h: number, deg: number): Point[] => {
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const).map(
    ([x, y]): Point => [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos]
  )
}

/** Góc chữ dọc theo đoạn a→b, quay về (-90, 90] để chữ luôn đứng — giống `Scene.label`. */
const uprightAngle = (a: Point, b: Point): number => {
  let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
  if (deg > 90) deg -= 180
  if (deg <= -90) deg += 180
  return deg
}

const boxPolygon = (b: Box, inset = 0): Point[] => [
  [b.x + inset, b.y + inset],
  [b.x + b.w - inset, b.y + inset],
  [b.x + b.w - inset, b.y + b.h - inset],
  [b.x + inset, b.y + b.h - inset]
]

const circlePolygon = (r: number): Point[] =>
  Array.from({ length: 64 }, (_, i): Point => [r * Math.cos((2 * Math.PI * i) / 64), r * Math.sin((2 * Math.PI * i) / 64)])

const pointToSegment = (p: Point, a: Point, b: Point): number => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

const orient = (a: Point, b: Point, c: Point): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

/** Khoảng cách nhỏ nhất giữa hai đoạn; 0 khi cắt nhau. */
const segmentDistance = (a: readonly [Point, Point], b: readonly [Point, Point]): number => {
  if (orient(a[0], a[1], b[0]) * orient(a[0], a[1], b[1]) < 0 && orient(b[0], b[1], a[0]) * orient(b[0], b[1], a[1]) < 0) return 0
  return Math.min(pointToSegment(a[0], b[0], b[1]), pointToSegment(a[1], b[0], b[1]), pointToSegment(b[0], a[0], a[1]), pointToSegment(b[1], a[0], a[1]))
}

interface Placement {
  radius: number
  boxes: Box[]
  geometry: Geometry[]
  sides: ContextSide[]
}

const place = (prepared: readonly Prepared[], left: Prepared[], right: Prepared[], radius: number, scale: number): Placement => {
  const ringX = scale * (radius + Math.max(ENT_MIN_W, ...prepared.map((p) => p.w)) / 2 + 150)
  const ringY = scale * (radius + 120)
  const slots = new Map<Prepared, { angle: number; side: ContextSide }>()
  for (const [group, side] of [[left, "left"], [right, "right"]] as const) {
    anglesFor(group, side, radius).forEach((angle, i) => slots.set(group[i], { angle, side }))
  }
  const boxes: Box[] = []
  const sides: ContextSide[] = []
  const geometry: Geometry[] = []
  prepared.forEach((p, owner) => {
    const slot = slots.get(p)!
    const ex = ringX * Math.cos(slot.angle)
    const ey = ringY * Math.sin(slot.angle)
    const dist = Math.hypot(ex, ey) || 1
    const u: Point = [ex / dist, ey / dist]
    const perp: Point = [-u[1], u[0]]
    // Chùm luồng rộng theo phương vuông góc trục: hộp phải phủ hết chùm, nên nới cạnh gần vuông góc với phương đó
    const cover = bundleWidth(p) + 28
    let w = p.w
    let h = p.h
    if (Math.abs(perp[1]) >= Math.abs(perp[0])) h = Math.max(h, (cover - w * Math.abs(perp[0])) / Math.abs(perp[1]))
    else w = Math.max(w, (cover - h * Math.abs(perp[1])) / Math.abs(perp[0]))
    const box: Box = { x: ex - w / 2, y: ey - h / 2, w, h }
    boxes.push(box)
    sides.push(slot.side)
    p.flows.forEach((f, k) => {
      const o = (k - (p.flows.length - 1) / 2) * FLOW_GAP
      const base: Point = [perp[0] * o, perp[1] * o]
      const tc = Math.sqrt(Math.max(0, radius * radius - o * o))
      const hit = rayThroughBox(base, u, box)
      // Trượt hộp ⇒ đặt điểm vô nghĩa; `needed` vô hạn làm cấu hình bị loại
      const tb = hit ? hit[0] : tc
      const onCircle: Point = [base[0] + u[0] * tc, base[1] + u[1] * tc]
      const onBox: Point = [base[0] + u[0] * tb, base[1] + u[1] * tb]
      const [from, to] = f.dir === "in" ? [onBox, onCircle] : [onCircle, onBox]
      const length = tb - tc
      const mid: Point = [(onBox[0] + onCircle[0]) / 2, (onBox[1] + onCircle[1]) / 2]
      const labelW = f.text === "" ? 0 : textWidth(f.text, LABEL_SIZE) + LABEL_PAD
      geometry.push({
        edge: { actorId: p.actor.id, flow: f.dir, index: f.index, text: f.text, from, to },
        owner,
        label: f.text === "" ? null : rotatedRect(mid, labelW, LABEL_H, uprightAngle(from, to)),
        head: arrowHeadShape("classic", to, from).points,
        length: hit ? length : -1,
        needed: (f.text === "" ? 0 : labelW) + LABEL_ROOM
      })
    })
  })
  return { radius, boxes, geometry, sides }
}

/** Hình hợp lệ khi không còn vi phạm nào mà `checkScene` hoặc luật không-cắt-nhau sẽ bắt. */
const isClean = ({ radius, boxes, geometry }: Placement): boolean => {
  if (geometry.some((g) => g.length < g.needed)) return false
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]
    const nearX = Math.max(a.x, Math.min(0, a.x + a.w))
    const nearY = Math.max(a.y, Math.min(0, a.y + a.h))
    if (Math.hypot(nearX, nearY) < radius + CIRCLE_CLEARANCE) return false
    for (const b of boxes.slice(i + 1)) {
      if (a.x < b.x + b.w + BOX_GAP && b.x < a.x + a.w + BOX_GAP && a.y < b.y + b.h + BOX_GAP && b.y < a.y + a.h + BOX_GAP) return false
    }
  }
  const circle = circlePolygon(radius)
  const inner = boxes.map((b) => boxPolygon(b, 1))
  const outer = boxes.map((b) => boxPolygon(b))
  for (let i = 0; i < geometry.length; i++) {
    const a = geometry[i]
    const seg: [Point, Point] = [a.edge.from, a.edge.to]
    // Đường chỉ chạm hộp của chính nó
    if (inner.some((poly, k) => k !== a.owner && overlaps(seg, poly, 0))) return false
    if (a.label) {
      if (outer.some((poly) => overlaps(a.label!, poly))) return false
      if (overlaps(a.label, circle)) return false
    }
    for (let j = i + 1; j < geometry.length; j++) {
      const b = geometry[j]
      const other: [Point, Point] = [b.edge.from, b.edge.to]
      if (a.owner !== b.owner && segmentDistance(seg, other) < SEGMENT_GAP) return false
      if (a.label && overlaps(other, a.label)) return false
      if (b.label && overlaps(seg, b.label)) return false
      if (a.label && b.label && overlaps(a.label, b.label)) return false
      if (a.label && overlaps(a.label, b.head)) return false
      if (b.label && overlaps(b.label, a.head)) return false
    }
  }
  return true
}

export const buildContextLayout = (actors: readonly ContextActor[], systemName = "System"): ContextLayout => {
  const systemLines = contextLabelLines(systemName, SYSTEM_WRAP)
  const prepared = actors.map(prepare)
  const { left, right } = splitSides(prepared)

  // Vòng tròn chứa trọn tên (nửa đường chéo khối chữ + lề), luồng dày nhất còn hợp lệ, và đủ chu vi cho các chùm
  const nameW = Math.max(...systemLines.map((l) => textWidth(l, NAME_SIZE, true)))
  const nameH = systemLines.length * NAME_LINE_HEIGHT
  const widest = Math.max(0, ...prepared.map(bundleWidth))
  const arcNeed = (group: Prepared[]): number => sum(clearances(group)) / (2 * SPAN_MAX)
  const radius = Math.ceil(Math.max(R_MIN, Math.hypot(nameW / 2, nameH / 2) + 10, widest / 2 + 20, arcNeed(left), arcNeed(right)))

  let placement = place(prepared, left, right, radius, 1)
  for (let step = 1; step <= GROW_MAX && !isClean(placement); step++) placement = place(prepared, left, right, Math.ceil(radius * GROW_STEP ** step), GROW_STEP ** step)

  const edges = placement.geometry.map((g) => g.edge)
  return {
    circle: { cx: 0, cy: 0, r: placement.radius, lines: systemLines },
    actors: prepared.map((p, i) => ({ ...p.actor, box: placement.boxes[i], lines: p.lines, side: placement.sides[i] })),
    edges
  }
}
