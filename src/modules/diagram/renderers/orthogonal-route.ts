/**
 * orthogonal-route.ts
 * ─────────────────────────────────────────────────────────────────
 * Hình học + định tuyến vuông góc trên lưới ô (`orthogonal-place.ts`), dùng chung cho ERD (3 ký pháp) và class diagram.
 * Không biết ký pháp: nút là hộp (kèm thân hình có cổng), cạnh là cặp nút + chiều dài tối thiểu hai đầu (chỗ cho ký hiệu).
 *
 * Cột / hàng rộng bằng nút lớn nhất, giữa các cột / hàng là khe (gap) có các làn (lane). Mỗi cạnh, theo thứ tự ngắn trước,
 * thử các dạng thẳng (I) → một góc (L) → chữ Z → chữ U trên mọi cặp cạnh hộp; ứng viên chỉ nhận khi: không xuyên hộp nào,
 * không chồng / dính đường đã vẽ (song song cách < `sepMin`), cổng cách cổng khác ≥ `portPitch`. Trong các ứng viên hợp
 * lệ chọn chi phí nhỏ nhất (độ dài + góc + điểm cắt vuông góc). Không có ứng viên ⇒ khe được nới và dựng lại; hết bậc nới ⇒
 * `null` (người gọi tách hình). Tất định: cùng đầu vào ⇒ cùng hình.
 */

import type { Point } from "../../../shared/diagram/svg-kit.js"
import type { Cell } from "./orthogonal-place.js"

export type Side = "L" | "R" | "T" | "B"
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface GridNode {
  id: string
  /** Hộp bao (gồm phần phụ như dải thuộc tính). */
  w: number
  h: number
  /** Thân hình: cổng nằm trên cạnh của thân; toạ độ tương đối góc trên trái hộp bao. Mặc định = hộp bao. */
  body?: Rect
  /** Cạnh được đặt cổng; mặc định cả bốn. */
  sides?: readonly Side[]
  /** Cổng chỉ ở giữa cạnh (hình thoi). */
  vertexPorts?: boolean
}

export interface GridEdge {
  id: string
  from: string
  to: string
  /** Độ dài tối thiểu của đoạn đầu / đoạn cuối (chỗ cho ký hiệu đầu mút). */
  endLeg: readonly [number, number]
}

export interface RouteOptions {
  gapX: number
  gapY: number
  /** Lề ngoài cùng (được nới để chứa làn ngoài, xem `ringOffset`). */
  pad: number
  /** Khoảng từ mép ngoài cùng của hộp tới làn ngoài đầu tiên — phải ≥ đoạn đầu / cuối dài nhất. */
  ringOffset: number
  portPitch: number
  portMargin: number
  laneStep: number
  /** Khoảng cách tối thiểu từ đường tới hộp không phải đầu mút. */
  clear: number
  /** Khoảng cách tối thiểu giữa hai đoạn song song chồng phạm vi. */
  sepMin: number
}

export const DEFAULT_ROUTE_OPTIONS: RouteOptions = { gapX: 90, gapY: 90, pad: 48, ringOffset: 40, portPitch: 26, portMargin: 12, laneStep: 14, clear: 4, sepMin: 12 }

export interface PlacedNode {
  id: string
  rect: Rect
  body: Rect
  sides: readonly Side[]
}

export interface RoutedEdge {
  id: string
  from: string
  to: string
  points: Point[]
  fromSide: Side
  toSide: Side
}

export interface GridLayout {
  nodes: Map<string, PlacedNode>
  edges: RoutedEdge[]
  width: number
  height: number
}

type Seg = readonly [Point, Point]
const ALL_SIDES: readonly Side[] = ["L", "R", "T", "B"]
const horizontal = (s: Seg): boolean => s[0][1] === s[1][1]
const lo = (a: number, b: number): number => Math.min(a, b)
const hi = (a: number, b: number): number => Math.max(a, b)
const EPS = 0.01

const segmentsOf = (pts: readonly Point[]): Seg[] => pts.slice(1).map((p, i): Seg => [pts[i], p])
const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d })

/** Đoạn trục-song-song cắt phần trong của hình chữ nhật. */
export const segmentHitsRect = (s: Seg, r: Rect): boolean => {
  if (horizontal(s)) return s[0][1] > r.y && s[0][1] < r.y + r.h && hi(s[0][0], s[1][0]) > r.x && lo(s[0][0], s[1][0]) < r.x + r.w
  return s[0][0] > r.x && s[0][0] < r.x + r.w && hi(s[0][1], s[1][1]) > r.y && lo(s[0][1], s[1][1]) < r.y + r.h
}

const pointToSeg = (p: Point, s: Seg): number => {
  const cx = Math.min(Math.max(p[0], lo(s[0][0], s[1][0])), hi(s[0][0], s[1][0]))
  const cy = Math.min(Math.max(p[1], lo(s[0][1], s[1][1])), hi(s[0][1], s[1][1]))
  return Math.hypot(p[0] - cx, p[1] - cy)
}

/** Hai đoạn cùng phương, cách nhau < `sep` và phạm vi chồng (hoặc sát nhau dưới `gap`). */
const parallelClash = (a: Seg, b: Seg, sep: number, gap: number): boolean => {
  if (horizontal(a) !== horizontal(b)) return false
  const k = horizontal(a) ? 1 : 0
  const m = 1 - k
  if (Math.abs(a[0][k] - b[0][k]) >= sep) return false
  return hi(lo(a[0][m], a[1][m]), lo(b[0][m], b[1][m])) - lo(hi(a[0][m], a[1][m]), hi(b[0][m], b[1][m])) < gap
}

/** Cắt vuông góc (hai đầu mút không chạm). */
const crosses = (a: Seg, b: Seg): boolean => {
  if (horizontal(a) === horizontal(b)) return false
  const [h, v] = horizontal(a) ? [a, b] : [b, a]
  return v[0][0] > lo(h[0][0], h[1][0]) && v[0][0] < hi(h[0][0], h[1][0]) && h[0][1] > lo(v[0][1], v[1][1]) && h[0][1] < hi(v[0][1], v[1][1])
}

const segLen = (s: Seg): number => Math.abs(s[1][0] - s[0][0]) + Math.abs(s[1][1] - s[0][1])

interface Placement {
  nodes: Map<string, PlacedNode>
  vLanes: number[]
  hLanes: number[]
  width: number
  height: number
}

const place = (nodes: readonly GridNode[], cells: ReadonlyMap<string, Cell>, o: RouteOptions): Placement => {
  const rows = [...new Set(nodes.map((n) => cells.get(n.id)!.row))].sort((a, b) => a - b)
  const cols = [...new Set(nodes.map((n) => cells.get(n.id)!.col))].sort((a, b) => a - b)
  const rowOf = new Map(rows.map((r, i) => [r, i]))
  const colOf = new Map(cols.map((c, i) => [c, i]))
  const bodyOf = (n: GridNode): Rect => n.body ?? { x: 0, y: 0, w: n.w, h: n.h }
  const above = rows.map(() => 0)
  const below = rows.map(() => 0)
  const colW = cols.map(() => 0)
  for (const n of nodes) {
    const c = cells.get(n.id)!
    const r = rowOf.get(c.row)!
    const b = bodyOf(n)
    const mid = b.y + b.h / 2
    above[r] = Math.max(above[r], mid)
    below[r] = Math.max(below[r], n.h - mid)
    colW[colOf.get(c.col)!] = Math.max(colW[colOf.get(c.col)!], n.w)
  }
  const colX: number[] = []
  let x = o.pad
  colW.forEach((w, i) => ((colX[i] = x), (x += w + o.gapX)))
  const width = x - o.gapX + o.pad
  const centerY: number[] = []
  let y = o.pad
  rows.forEach((_, i) => ((centerY[i] = y + above[i]), (y += above[i] + below[i] + o.gapY)))
  const height = y - o.gapY + o.pad

  const placed = new Map<string, PlacedNode>()
  for (const n of nodes) {
    const c = cells.get(n.id)!
    const b = bodyOf(n)
    const nx = colX[colOf.get(c.col)!] + (colW[colOf.get(c.col)!] - n.w) / 2
    const ny = centerY[rowOf.get(c.row)!] - (b.y + b.h / 2)
    placed.set(n.id, { id: n.id, rect: { x: nx, y: ny, w: n.w, h: n.h }, body: { x: nx + b.x, y: ny + b.y, w: b.w, h: b.h }, sides: n.vertexPorts ? ALL_SIDES : (n.sides ?? ALL_SIDES) })
  }

  const lanes = (starts: readonly number[], sizes: readonly number[], gap: number, total: number): number[] => {
    const out: number[] = []
    for (let i = 0; i < starts.length - 1; i++) {
      const from = starts[i] + sizes[i]
      const n = Math.max(1, Math.floor(gap / o.laneStep) - 1)
      for (let k = 1; k <= n; k++) out.push(from + (gap * k) / (n + 1))
    }
    const ring = [0, 1, 2, 3].map((k) => o.pad - o.ringOffset - k * o.laneStep)
    return [...ring, ...out, ...ring.map((v) => total - v)].sort((a, b) => a - b)
  }
  const rowStart = centerY.map((c, i) => c - above[i])
  const rowSize = rows.map((_, i) => above[i] + below[i])
  return { nodes: placed, vLanes: lanes(colX, colW, o.gapX, width), hLanes: lanes(rowStart, rowSize, o.gapY, height), width, height }
}

interface Candidate {
  pts: Point[]
  sa: Side
  sb: Side
  ca: number
  cb: number
}

const routeAll = (nodes: readonly GridNode[], edges: readonly GridEdge[], cells: ReadonlyMap<string, Cell>, base: RouteOptions): GridLayout | null => {
  const longestLeg = Math.max(0, ...edges.flatMap((e) => e.endLeg))
  const ringOffset = Math.max(base.ringOffset, longestLeg + 10)
  const o: RouteOptions = { ...base, ringOffset, pad: Math.max(base.pad, ringOffset + 3 * base.laneStep + 12) }
  const geo = place(nodes, cells, o)
  const spec = new Map(nodes.map((n) => [n.id, n]))
  const used = new Map<string, number[]>()
  const placedSegs: { seg: Seg; edge: string }[] = []
  const allRects = [...geo.nodes.values()].map((n) => ({ id: n.id, rect: inflate(n.rect, o.clear) }))
  const half = o.portPitch / 2

  const coordsOf = (n: PlacedNode, side: Side): number[] => {
    const horizontalSide = side === "L" || side === "R"
    const [start, size] = horizontalSide ? [n.body.y, n.body.h] : [n.body.x, n.body.w]
    const center = start + size / 2
    if (spec.get(n.id)?.vertexPorts || size < 2 * o.portMargin) return [center]
    const out: number[] = []
    for (let k = 0; center + k * half <= start + size - o.portMargin + EPS; k++) {
      out.push(center + k * half)
      if (k > 0) out.push(center - k * half)
    }
    return out
  }
  const free = (n: PlacedNode, side: Side, c: number): boolean => {
    if (!n.sides.includes(side)) return false
    const list = used.get(`${n.id}:${side}`) ?? []
    return spec.get(n.id)?.vertexPorts ? list.length === 0 : list.every((u) => Math.abs(u - c) >= o.portPitch - EPS)
  }
  const near = (n: PlacedNode, side: Side, target: number, k = 4): number[] =>
    coordsOf(n, side)
      .filter((c) => free(n, side, c))
      .sort((p, q) => Math.abs(p - target) - Math.abs(q - target) || p - q)
      .slice(0, k)
  const point = (n: PlacedNode, side: Side, c: number): Point =>
    side === "L" ? [n.body.x, c] : side === "R" ? [n.body.x + n.body.w, c] : side === "T" ? [c, n.body.y] : [c, n.body.y + n.body.h]
  const centerOf = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2]

  const candidates = (A: PlacedNode, B: PlacedNode, legA: number, legB: number): Candidate[] => {
    const out: Candidate[] = []
    const a = { l: A.body.x, r: A.body.x + A.body.w, t: A.body.y, b: A.body.y + A.body.h }
    const b = { l: B.body.x, r: B.body.x + B.body.w, t: B.body.y, b: B.body.y + B.body.h }
    const cA = centerOf(A.body)
    const cB = centerOf(B.body)
    const lanesIn = (lanes: number[], from: number, to: number, mid: number): number[] =>
      lanes.filter((v) => v >= from && v <= to).sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid)).slice(0, 8)
    const lanesFrom = (lanes: number[], limit: number, dir: 1 | -1): number[] =>
      lanes.filter((v) => (dir === 1 ? v >= limit : v <= limit)).sort((p, q) => Math.abs(p - limit) - Math.abs(q - limit)).slice(0, 6)
    const push = (pts: Point[], sa: Side, sb: Side, ca: number, cb: number): void => void out.push({ pts, sa, sb, ca, cb })

    for (const sa of A.sides) {
      for (const sb of B.sides) {
        const hA = sa === "L" || sa === "R"
        const hB = sb === "L" || sb === "R"
        const targetA = hA ? cB[1] : cB[0]
        const targetB = hB ? cA[1] : cA[0]
        const listA = near(A, sa, targetA)
        const listB = near(B, sb, targetB)
        // I: hai cạnh đối nhau, cùng toạ độ
        const facing =
          (sa === "R" && sb === "L" && a.r + legA + legB <= b.l) ||
          (sa === "L" && sb === "R" && b.r + legA + legB <= a.l) ||
          (sa === "B" && sb === "T" && a.b + legA + legB <= b.t) ||
          (sa === "T" && sb === "B" && b.b + legA + legB <= a.t)
        if (facing) {
          const shared = [...new Set([...listA, ...listB, ...near(A, sa, targetA, 12)])].filter((c) => free(A, sa, c) && free(B, sb, c) && coordsOf(A, sa).some((v) => Math.abs(v - c) < EPS) && coordsOf(B, sb).some((v) => Math.abs(v - c) < EPS))
          for (const c of shared) push([point(A, sa, c), point(B, sb, c)], sa, sb, c, c)
        }
        // L: một góc
        if (hA !== hB) {
          for (const ca of listA)
            for (const cb of listB) {
              const pa = point(A, sa, ca)
              const pb = point(B, sb, cb)
              const corner: Point = hA ? [cb, ca] : [ca, cb]
              const okA = hA ? (sa === "R" ? corner[0] >= a.r + legA : corner[0] <= a.l - legA) : sa === "B" ? corner[1] >= a.b + legA : corner[1] <= a.t - legA
              const okB = hB ? (sb === "R" ? corner[0] >= b.r + legB : corner[0] <= b.l - legB) : sb === "B" ? corner[1] >= b.b + legB : corner[1] <= b.t - legB
              if (okA && okB) push([pa, corner, pb], sa, sb, ca, cb)
            }
        }
        // Z: hai cạnh đối nhau hướng vào nhau, đoạn giữa nằm trên một làn
        if (hA === hB && sa !== sb) {
          const toward =
            (sa === "R" && sb === "L" && a.r + legA <= b.l - legB) ||
            (sa === "L" && sb === "R" && b.r + legB <= a.l - legA) ||
            (sa === "B" && sb === "T" && a.b + legA <= b.t - legB) ||
            (sa === "T" && sb === "B" && b.b + legB <= a.t - legA)
          if (toward) {
            const range: [number, number] = hA ? (sa === "R" ? [a.r + legA, b.l - legB] : [b.r + legB, a.l - legA]) : sa === "B" ? [a.b + legA, b.t - legB] : [b.b + legB, a.t - legA]
            for (const lane of lanesIn(hA ? geo.vLanes : geo.hLanes, range[0], range[1], (range[0] + range[1]) / 2))
              for (const ca of listA)
                for (const cb of listB) {
                  if (Math.abs(ca - cb) < o.sepMin) continue
                  const pa = point(A, sa, ca)
                  const pb = point(B, sb, cb)
                  push(hA ? [pa, [lane, ca], [lane, cb], pb] : [pa, [ca, lane], [cb, lane], pb], sa, sb, ca, cb)
                }
          }
        }
        // U: cùng một cạnh, đoạn giữa nằm trên làn ngoài cả hai hộp
        if (sa === sb) {
          const limit = sa === "R" ? hi(a.r + legA, b.r + legB) : sa === "L" ? lo(a.l - legA, b.l - legB) : sa === "B" ? hi(a.b + legA, b.b + legB) : lo(a.t - legA, b.t - legB)
          const dir: 1 | -1 = sa === "R" || sa === "B" ? 1 : -1
          for (const lane of lanesFrom(hA ? geo.vLanes : geo.hLanes, limit, dir))
            for (const ca of listA)
              for (const cb of listB) {
                if (Math.abs(ca - cb) < o.sepMin) continue
                const pa = point(A, sa, ca)
                const pb = point(B, sb, cb)
                push(hA ? [pa, [lane, ca], [lane, cb], pb] : [pa, [ca, lane], [cb, lane], pb], sa, sb, ca, cb)
              }
        }
      }
    }
    return out
  }

  const evaluate = (cand: Candidate, A: PlacedNode, B: PlacedNode, edge: GridEdge): number | null => {
    const segs = segmentsOf(cand.pts)
    if (segs.length === 0 || segs.some((s) => segLen(s) < EPS)) return null
    if (segLen(segs[0]) < edge.endLeg[0] - EPS || segLen(segs[segs.length - 1]) < edge.endLeg[1] - EPS) return null
    if (segs.slice(1, -1).some((s) => segLen(s) < o.sepMin)) return null
    for (let i = 0; i < segs.length; i++) {
      for (const n of allRects) {
        if ((n.id === A.id && i === 0) || (n.id === B.id && i === segs.length - 1)) continue
        if (segmentHitsRect(segs[i], n.rect)) return null
      }
      for (let j = i + 1; j < segs.length; j++) if (parallelClash(segs[i], segs[j], o.sepMin, 6)) return null
    }
    let crossings = 0
    for (const s of segs)
      for (const e of placedSegs) {
        if (parallelClash(s, e.seg, o.sepMin, 6)) return null
        if (crosses(s, e.seg)) crossings++
        else if (horizontal(s) !== horizontal(e.seg) && (s.some((p) => pointToSeg(p, e.seg) < 6) || e.seg.some((p) => pointToSeg(p, s) < 6))) return null
      }
    const length = segs.reduce((n, s) => n + segLen(s), 0)
    const ca = centerOf(A.body)
    const cb = centerOf(B.body)
    const off = Math.abs(cand.ca - (cand.sa === "L" || cand.sa === "R" ? ca[1] : ca[0])) + Math.abs(cand.cb - (cand.sb === "L" || cand.sb === "R" ? cb[1] : cb[0]))
    return length + 24 * (segs.length - 1) + 60 * crossings + 0.3 * off
  }

  const dist = (e: GridEdge): number => {
    const a = centerOf(geo.nodes.get(e.from)!.rect)
    const b = centerOf(geo.nodes.get(e.to)!.rect)
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
  }
  const order = [...edges].sort((p, q) => dist(p) - dist(q) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
  const routed = new Map<string, RoutedEdge>()
  for (const edge of order) {
    const A = geo.nodes.get(edge.from)!
    const B = geo.nodes.get(edge.to)!
    let best: Candidate | null = null
    let bestCost = Infinity
    for (const cand of candidates(A, B, edge.endLeg[0], edge.endLeg[1])) {
      const cost = evaluate(cand, A, B, edge)
      if (cost !== null && cost < bestCost - EPS) {
        best = cand
        bestCost = cost
      }
    }
    if (!best) return null
    for (const s of segmentsOf(best.pts)) placedSegs.push({ seg: s, edge: edge.id })
    for (const [n, side, c] of [[A, best.sa, best.ca], [B, best.sb, best.cb]] as const) used.set(`${n.id}:${side}`, [...(used.get(`${n.id}:${side}`) ?? []), c])
    routed.set(edge.id, { id: edge.id, from: edge.from, to: edge.to, points: best.pts, fromSide: best.sa, toSide: best.sb })
  }
  return { nodes: geo.nodes, edges: edges.map((e) => routed.get(e.id)!), width: geo.width, height: geo.height }
}

/** Khe nới thêm (px) thử lần lượt khi có cạnh không tìm được đường. */
export const GAP_WIDENING: readonly number[] = [0, 30, 60, 100, 160]

/**
 * `accept`: người gọi còn việc phải đạt trên bố cục (vd đặt đủ nhãn) — không đạt thì nới khe thêm một bậc và dựng lại.
 */
export const routeOnGrid = (
  nodes: readonly GridNode[],
  edges: readonly GridEdge[],
  cells: ReadonlyMap<string, Cell>,
  options: RouteOptions = DEFAULT_ROUTE_OPTIONS,
  accept: (layout: GridLayout) => boolean = () => true
): GridLayout | null => {
  for (const extra of GAP_WIDENING) {
    const layout = routeAll(nodes, edges, cells, { ...options, gapX: options.gapX + extra, gapY: options.gapY + extra, ringOffset: options.ringOffset + extra })
    if (layout && accept(layout)) return layout
  }
  return null
}

// ─── đặt nhãn ────────────────────────────────────────────────────

export interface LabelSpot {
  /** Tâm nhãn. */
  at: Point
  /** Nhãn nằm đè lên chính đường của nó (nền trắng cắt đường) — được phép chạm đoạn của cạnh này. */
  onLine: boolean
}

export interface LabelRequest {
  id: string
  edge: string
  w: number
  h: number
  spots: readonly LabelSpot[]
}

const rectsOverlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Chọn tâm cho từng nhãn: vị trí đầu tiên (theo thứ tự `spots`) mà hộp nhãn không chạm hộp, đường của cạnh khác (và của
 * chính cạnh nếu không `onLine`), vùng cấm (`avoid`: ký hiệu đầu mút…) hay nhãn đã đặt. Không chỗ ⇒ `null` cho cả lô.
 */
export const placeLabels = (requests: readonly LabelRequest[], routes: readonly RoutedEdge[], avoid: readonly Rect[]): Map<string, Point> | null => {
  const segs = routes.flatMap((r) => segmentsOf(r.points).map((seg) => ({ seg, edge: r.id })))
  const blocked: Rect[] = [...avoid]
  const result = new Map<string, Point>()
  for (const req of requests) {
    const spot = req.spots.find((s) => {
      const box: Rect = inflate({ x: s.at[0] - req.w / 2, y: s.at[1] - req.h / 2, w: req.w, h: req.h }, 1.5)
      if (blocked.some((r) => rectsOverlap(box, r))) return false
      return !segs.some((e) => (s.onLine && e.edge === req.edge ? false : segmentHitsRect(e.seg, box)))
    })
    if (!spot) return null
    result.set(req.id, spot.at)
    blocked.push({ x: spot.at[0] - req.w / 2, y: spot.at[1] - req.h / 2, w: req.w, h: req.h })
  }
  return result
}
