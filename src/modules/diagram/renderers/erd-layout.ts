/**
 * erd-layout.ts
 * ─────────────────────────────────────────────────────────────────
 * ERD dựng bằng SVG cho ba ký pháp — Chen, Crow's foot, IDEF1X — trên MỘT bộ xếp lưới + đi đường vuông góc dùng chung
 * (`orthogonal-place.ts`, `orthogonal-route.ts`). Ký pháp chỉ quyết định: hình nút (hộp, hình thoi Chen), nút phụ nào có
 * trong đồ thị (Chen: mỗi quan hệ là một nút hình thoi nằm giữa hai entity), ký hiệu đầu mút và nhãn.
 *
 * Mọi hình tô `#7ACFF5`, viền / chữ đen. Dữ liệu vào là cha → con (`from` → `to`): đầu cha `1` hoặc `0..1` (khi
 * `optional`: con tồn tại được khi không có cha), đầu con theo `cardinality` (`N` nhiều, `1` một), số tối thiểu phía con
 * không có trong Spine nên coi là 0. Thuộc tính (`attributes`) chưa có trong Spine: hộp không có ngăn thuộc tính / Chen
 * không có hình ô-van cho tới khi dữ liệu có — mã vẽ sẵn, kiểm bằng test.
 */

import { fontAscent, fontDescent, INK, PAPER, textWidth, type Point } from "../../../shared/diagram/svg-kit.js"
import type { ErdNotation } from "../../../shared/diagram/erd-notation.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"
import { placeOnGrid } from "./orthogonal-place.js"
import { DEFAULT_ROUTE_OPTIONS, placeLabels, routeOnGrid, type GridEdge, type GridLayout, type GridNode, type LabelRequest, type LabelSpot, type PlacedNode, type Rect, type RoutedEdge } from "./orthogonal-route.js"
import { wrapLines } from "./usecase-layout.js"

export interface ErdAttribute {
  name: string
  pk?: boolean
  fk?: boolean
}

export interface ErdEntityInput {
  id: string
  name: string
  attributes?: readonly ErdAttribute[]
  /** IDEF1X: thực thể phụ thuộc (định danh qua quan hệ định danh) — góc bo tròn. */
  dependent?: boolean
}

export interface ErdRelationInput {
  /** Id ổn định theo Spine, vd `E01>E02`. */
  id: string
  /** Cha (phía một). */
  from: string
  /** Con. */
  to: string
  verb: string
  cardinality: "1" | "N"
  /** Con tồn tại được khi không có cha này. */
  optional: boolean
  /** IDEF1X: quan hệ định danh (nét liền); thiếu ⇒ không định danh (nét đứt). */
  identifying?: boolean
}

export interface ErdDiagram {
  notation: ErdNotation
  entities: readonly ErdEntityInput[]
  relations: readonly ErdRelationInput[]
  /** Chữ của hộp giữ chỗ khi chưa có entity. */
  emptyLabel: string
}

const NAME_SIZE = 14
const ATTR_SIZE = 12
const NAME_LINE = 18
const ATTR_LINE = 17
const VERB_SIZE = 12
const VERB_LINE = 15
const CARD_SIZE = 12
const MAX_NAME_WIDTH = 170
const MAX_VERB_WIDTH = 110

const clean = (text: string): string => text.replace(/\s+/g, " ").trim()

// ─── kích thước nút ──────────────────────────────────────────────

interface EntityBox {
  input: ErdEntityInput
  nameLines: string[]
  headerH: number
  rows: { text: string; pk: boolean; gapBefore: boolean }[]
  boxW: number
  boxH: number
  node: GridNode
  /** Chen: bố trí ô-van thuộc tính dưới hộp. */
  ovals: { rx: number; ry: number; name: string; pk: boolean }[]
}

const attributeRows = (notation: ErdNotation, attrs: readonly ErdAttribute[]): EntityBox["rows"] => {
  if (notation === "chen") return []
  const ordered = notation === "idef1x" ? [...attrs.filter((a) => a.pk), ...attrs.filter((a) => !a.pk)] : [...attrs]
  return ordered.map((a, i) => ({
    text: notation === "crowsfoot" ? `${a.pk ? "PK " : ""}${a.fk ? "FK " : ""}${clean(a.name)}` : `${clean(a.name)}${a.fk ? " (FK)" : ""}`,
    pk: a.pk === true,
    gapBefore: notation === "idef1x" && i > 0 && ordered[i - 1].pk === true && a.pk !== true
  }))
}

const entityBox = (e: ErdEntityInput, notation: ErdNotation, degree: number, selfLoops: number, o = DEFAULT_ROUTE_OPTIONS): EntityBox => {
  const nameLines = wrapLines(clean(e.name) || e.id, NAME_SIZE, MAX_NAME_WIDTH, 2)
  const nameW = Math.max(...nameLines.map((l) => textWidth(l, NAME_SIZE, true)))
  const rows = attributeRows(notation, e.attributes ?? [])
  const headerH = Math.max(38, nameLines.length * NAME_LINE + 16)
  const attrH = rows.length > 0 ? 12 + rows.length * ATTR_LINE + rows.filter((r) => r.gapBefore).length * 8 : 0
  const attrW = Math.max(0, ...rows.map((r) => textWidth(r.text, ATTR_SIZE, r.pk)))
  // đủ chỗ cho các cổng: tối đa nửa số đầu mút dồn vào một cạnh
  const slots = Math.max(1, Math.ceil((degree - 2 * selfLoops) / 2) + 2 * selfLoops)
  const portSpan = 2 * o.portMargin + (slots - 1) * o.portPitch
  const boxW = Math.max(110, Math.ceil(nameW + 28), Math.ceil(attrW + 24), portSpan)
  const boxH = Math.max(headerH + attrH, portSpan)
  const ovals = notation === "chen" ? (e.attributes ?? []).map((a) => ({ name: clean(a.name), pk: a.pk === true, rx: Math.ceil(textWidth(clean(a.name), ATTR_SIZE, a.pk === true) / 2) + 12, ry: 13 })) : []
  const stripW = ovals.reduce((sum, v) => sum + 2 * v.rx, 0) + Math.max(0, ovals.length - 1) * 10
  const w = Math.max(boxW, stripW)
  const h = ovals.length > 0 ? boxH + 24 + 26 + 4 : boxH
  const node: GridNode = { id: e.id, w, h, body: { x: (w - boxW) / 2, y: 0, w: boxW, h: boxH }, ...(ovals.length > 0 ? { sides: ["L", "R", "T"] as const } : {}) }
  return { input: e, nameLines, headerH, rows, boxW, boxH, node, ovals }
}

interface DiamondBox {
  id: string
  relation: ErdRelationInput
  lines: string[]
  hw: number
  hh: number
  node: GridNode
}

const diamondBox = (r: ErdRelationInput): DiamondBox => {
  const lines = wrapLines(clean(r.verb), VERB_SIZE, MAX_VERB_WIDTH, 3)
  const textW = Math.max(...lines.map((l) => textWidth(l, VERB_SIZE)))
  const a = textW / 2 + 4
  const b = ((lines.length - 1) * VERB_LINE + fontAscent(VERB_SIZE) + fontDescent(VERB_SIZE)) / 2 + 2
  const hw = Math.ceil(Math.max(34, 2.3 * a))
  const hh = Math.ceil(Math.max(22, 2.3 * b))
  const id = `R:${r.id}`
  return { id, relation: r, lines, hw, hh, node: { id, w: 2 * hw, h: 2 * hh, vertexPorts: true } }
}

// ─── ký hiệu đầu mút ─────────────────────────────────────────────

type EndKind = "one" | "zeroOne" | "oneMany" | "zeroMany"

/** Đầu cha: `1` hoặc `0..1`; đầu con: nhiều / một, tối thiểu 0 (Spine không ghi). */
const parentEnd = (r: ErdRelationInput): EndKind => (r.optional ? "zeroOne" : "one")
const childEnd = (r: ErdRelationInput): EndKind => (r.cardinality === "N" ? "zeroMany" : "zeroOne")

/** Đoạn đầu / cuối tối thiểu (chỗ cho ký hiệu) và bán kính vùng cấm quanh ký hiệu. */
const LEGS: Record<ErdNotation, { entity: number; diamond: number; zone: number }> = {
  chen: { entity: 22, diamond: 14, zone: 0 },
  crowsfoot: { entity: 30, diamond: 0, zone: 26 },
  idef1x: { entity: 26, diamond: 0, zone: 18 }
}

interface End {
  p: Point
  /** Vector đơn vị từ đầu mút dọc theo đường, rời xa hộp. */
  d: Point
}

const endOf = (points: readonly Point[], end: 0 | 1): End => {
  const [p, q] = end === 0 ? [points[0], points[1]] : [points[points.length - 1], points[points.length - 2]]
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
  return { p, d: [(q[0] - p[0]) / len, (q[1] - p[1]) / len] }
}

const at = ({ p, d }: End, along: number, side: number): Point => [p[0] + d[0] * along - d[1] * side, p[1] + d[1] * along + d[0] * side]

const drawEnd = (scene: Scene, edgeId: string, end: End, index: 0 | 1, notation: ErdNotation, kind: EndKind): void => {
  const id = (name: string): string => `${edgeId}#e${index}-${name}`
  if (notation === "crowsfoot") {
    const bar = (name: string, along: number): string => scene.decoration(id(name), edgeId, [at(end, along, -6), at(end, along, 6)])
    const foot = (): void => {
      scene.decoration(id("foot-a"), edgeId, [at(end, 12, 0), at(end, 0, 7)])
      scene.decoration(id("foot-b"), edgeId, [at(end, 12, 0), at(end, 0, -7)])
    }
    const ring = (along: number): string => scene.decorationCircle(id("ring"), edgeId, ...at(end, along, 0), 5, PAPER)
    if (kind === "one") (bar("bar-1", 8), bar("bar-2", 14))
    else if (kind === "zeroOne") (bar("bar-1", 8), ring(18))
    else if (kind === "oneMany") (foot(), bar("bar-1", 17))
    else (foot(), ring(18))
    return
  }
  // IDEF1X: chấm đặc ở đầu con; hình thoi rỗng ở đầu cha khi liên kết tuỳ chọn (khoá ngoại cho phép rỗng)
  if (kind === "zeroMany" || (kind === "zeroOne" && index === 1)) scene.decorationCircle(id("dot"), edgeId, ...at(end, 9, 0), 4.5, INK)
  else if (kind === "zeroOne") scene.decoration(id("optional"), edgeId, [at(end, 3, 0), at(end, 9, 5), at(end, 15, 0), at(end, 9, -5)], { closed: true, fill: PAPER })
}

// ─── nhãn ────────────────────────────────────────────────────────

const rectAround = (p: Point, w: number, h: number): Rect => ({ x: p[0] - w / 2, y: p[1] - h / 2, w, h })

/** Vùng cấm quanh ký hiệu đầu mút (nhãn khác không được vào). */
const zoneRect = (end: End, length: number, half: number): Rect => {
  const far = at(end, length, 0)
  const [x0, x1] = [Math.min(end.p[0], far[0]), Math.max(end.p[0], far[0])]
  const [y0, y1] = [Math.min(end.p[1], far[1]), Math.max(end.p[1], far[1])]
  return Math.abs(end.d[0]) > 0.5 ? { x: x0, y: y0 - half, w: x1 - x0, h: 2 * half } : { x: x0 - half, y: y0, w: 2 * half, h: y1 - y0 }
}

/** Chỗ đặt chữ ngắn (`1`, `N`, `Z`) cạnh đoạn đầu: sát hộp trước, hai bên đường. */
const endSpots = (end: End, w: number, h: number, clear: number): LabelSpot[] => {
  const spots: LabelSpot[] = []
  const vertical = Math.abs(end.d[1]) > 0.5
  for (const along of [8, 16, 24]) {
    for (const side of [1, -1]) {
      const reach = (vertical ? h : w) / 2 + along
      const offset = (vertical ? w : h) / 2 + clear
      spots.push({ at: at(end, reach, side * offset), onLine: false })
    }
  }
  return spots
}

/** Chỗ đặt nhãn động từ: đoạn dài trước; giữa đoạn trước; đè lên đường (nền trắng cắt đường) trước, rồi cạnh đường. */
const verbSpots = (points: readonly Point[], w: number, h: number): LabelSpot[] => {
  const segs = points.slice(1).map((q, i) => [points[i], q] as const).sort((a, b) => Math.abs(b[1][0] - b[0][0]) + Math.abs(b[1][1] - b[0][1]) - (Math.abs(a[1][0] - a[0][0]) + Math.abs(a[1][1] - a[0][1])))
  const spots: LabelSpot[] = []
  for (const [a, b] of segs) {
    const isH = a[1] === b[1]
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const p: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      if (isH) spots.push({ at: p, onLine: true }, { at: [p[0], p[1] - h / 2 - 4], onLine: false }, { at: [p[0], p[1] + h / 2 + 4], onLine: false })
      else spots.push({ at: p, onLine: true }, { at: [p[0] + w / 2 + 6, p[1]], onLine: false }, { at: [p[0] - w / 2 - 6, p[1]], onLine: false })
    }
  }
  return spots
}

// ─── đường đôi (Chen: tham gia toàn phần) ────────────────────────

/** Đường song song cách `offset` (px) bên trái hướng đi; mọi đoạn trục-song-song. */
const offsetPath = (points: readonly Point[], offset: number): Point[] => {
  const normal = (a: Point, b: Point): Point => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]
  }
  return points.map((p, i): Point => {
    const n1 = i > 0 ? normal(points[i - 1], p) : null
    const n2 = i < points.length - 1 ? normal(p, points[i + 1]) : null
    const nx = (n1?.[0] ?? 0) + (n2?.[0] ?? 0)
    const ny = (n1?.[1] ?? 0) + (n2?.[1] ?? 0)
    return [p[0] + nx * offset, p[1] + ny * offset]
  })
}

/** Dời điểm đầu của đường dọc theo đoạn đầu `by` px (âm = lùi vào trong hình thoi: đường song song cắt cạnh xiên, không phải đỉnh). */
const trimStart = (points: Point[], by: number): Point[] => {
  const [a, b] = points
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return [[a[0] + ((b[0] - a[0]) / len) * by, a[1] + ((b[1] - a[1]) / len) * by], ...points.slice(1)]
}

// ─── dựng hình ───────────────────────────────────────────────────

interface Plan {
  layout: GridLayout
  centers: Map<string, Point>
  requests: LabelRequest[]
}

const OPTIONS: Record<ErdNotation, { gapX: number; gapY: number }> = {
  chen: { gapX: 64, gapY: 56 },
  crowsfoot: { gapX: 96, gapY: 84 },
  idef1x: { gapX: 90, gapY: 80 }
}

const placeholder = (label: string): Scene => {
  const scene = new Scene()
  const w = Math.ceil(textWidth(label, NAME_SIZE, true)) + 40
  scene.rect("NO_ENTITIES", 0, 0, w, 48, { name: label })
  scene.text("NO_ENTITIES#name", w / 2, 24, label, { size: NAME_SIZE, bold: true, baseline: "central", owner: "NO_ENTITIES" })
  return scene
}

/** Scene của một hình ERD; `null` khi không tìm được đường cho mọi cạnh dù nới khe (người gọi tách hình). */
export const layoutErd = (d: ErdDiagram): Scene | null => {
  if (d.entities.length === 0) return placeholder(d.emptyLabel)
  const notation = d.notation
  const known = new Set(d.entities.map((e) => e.id))
  const relations = d.relations.filter((r) => known.has(r.from) && known.has(r.to))
  const degree = new Map<string, number>()
  for (const r of relations) for (const id of [r.from, r.to]) degree.set(id, (degree.get(id) ?? 0) + 1)

  const selfLoops = new Map<string, number>()
  for (const r of relations) if (r.from === r.to) selfLoops.set(r.from, (selfLoops.get(r.from) ?? 0) + 1)
  const entities = d.entities.map((e) => entityBox(e, notation, degree.get(e.id) ?? 0, selfLoops.get(e.id) ?? 0))
  const diamonds = notation === "chen" ? relations.map(diamondBox) : []
  const legs = LEGS[notation]
  const edges: GridEdge[] = []
  const links: [string, string][] = []
  const diamondOf = new Map(diamonds.map((m) => [m.relation.id, m]))
  for (const r of relations) {
    const m = diamondOf.get(r.id)
    if (m) {
      edges.push({ id: `${m.id}:p`, from: r.from, to: m.id, endLeg: [legs.entity, legs.diamond] }, { id: `${m.id}:c`, from: m.id, to: r.to, endLeg: [legs.diamond, legs.entity] })
      links.push([r.from, m.id], [m.id, r.to])
    } else {
      edges.push({ id: `R:${r.id}`, from: r.from, to: r.to, endLeg: [legs.entity, legs.entity] })
      links.push([r.from, r.to])
    }
  }
  const nodes = [...entities.map((e) => e.node), ...diamonds.map((m) => m.node)]
  const cells = placeOnGrid(nodes.map((n) => n.id), links, Math.max(4, Math.round(Math.sqrt(nodes.length * 1.8))))

  const relationOf = (edgeId: string): ErdRelationInput => relations.find((r) => edgeId === `R:${r.id}` || edgeId === `R:${r.id}:p` || edgeId === `R:${r.id}:c`)!
  const edgeEnds = (route: RoutedEdge): { entityEnd: 0 | 1 | null; kind: EndKind | null; letter: string | null; index: 0 | 1 }[] => {
    const r = relationOf(route.id)
    if (notation === "chen") {
      // entity là đầu cha của `:p`, đầu con của `:c`
      return route.id.endsWith(":p")
        ? [{ entityEnd: 0, kind: null, letter: "1", index: 0 }]
        : [{ entityEnd: 1, kind: null, letter: r.cardinality, index: 1 }]
    }
    const letter = notation === "idef1x" && r.cardinality === "1" ? "Z" : null
    return [
      { entityEnd: 0, kind: parentEnd(r), letter: null, index: 0 },
      { entityEnd: 1, kind: childEnd(r), letter, index: 1 }
    ]
  }

  const plan = (layout: GridLayout): Plan | null => {
    // thân hình + dải phụ bên dưới (ô-van thuộc tính): phần hộp bao ngoài hai vùng đó là chỗ trống, nhãn cạnh cổng được vào
    const avoid: Rect[] = [...layout.nodes.values()].flatMap((n) => {
      const grow = (r: Rect): Rect => ({ x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 })
      const stripTop = n.body.y + n.body.h
      const strip = n.rect.y + n.rect.h - stripTop
      return strip > 1 ? [grow(n.body), grow({ x: n.rect.x, y: stripTop, w: n.rect.w, h: strip })] : [grow(n.body)]
    })
    const requests: LabelRequest[] = []
    for (const route of [...layout.edges].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      for (const e of edgeEnds(route)) {
        const end = endOf(route.points, e.index)
        if (legs.zone > 0) avoid.push(zoneRect(end, legs.zone, 8))
        if (e.letter) {
          const w = textWidth(e.letter, CARD_SIZE) + 4
          requests.push({ id: `${route.id}#card`, edge: route.id, w, h: 16, spots: endSpots(end, w, 16, notation === "chen" ? 4 : 10) })
        }
      }
    }
    if (notation !== "chen") {
      for (const route of layout.edges) {
        const r = relationOf(route.id)
        const lines = wrapLines(clean(r.verb), VERB_SIZE, MAX_VERB_WIDTH, 2)
        const w = Math.max(...lines.map((l) => textWidth(l, VERB_SIZE))) + 8
        const h = lines.length * VERB_LINE + 4
        requests.push({ id: `${route.id}#label`, edge: route.id, w, h, spots: verbSpots(route.points, w, h) })
      }
    }
    const centers = placeLabels(requests, layout.edges, avoid)
    return centers ? { layout, centers, requests } : null
  }

  const holder: { plan: Plan | null } = { plan: null }
  const layout = routeOnGrid(nodes, edges, cells, { ...DEFAULT_ROUTE_OPTIONS, ...OPTIONS[notation] }, (l) => ((holder.plan = plan(l)), holder.plan !== null))
  if (!layout || !holder.plan) return null
  const { centers, requests } = holder.plan

  const scene = new Scene()
  // hộp / hình thoi trước, đường sau (đường chỉ chạm viền), ký hiệu đầu mút và nhãn trên cùng
  for (const e of entities) drawEntity(scene, e, layout.nodes.get(e.input.id)!, notation)
  for (const m of diamonds) {
    const n = layout.nodes.get(m.id)!
    const cx = n.rect.x + m.hw
    const cy = n.rect.y + m.hh
    scene.polygon(m.id, [[cx - m.hw, cy], [cx, cy - m.hh], [cx + m.hw, cy], [cx, cy + m.hh]], { name: m.relation.verb })
    m.lines.forEach((line, i) => scene.text(`${m.id}#name-${i}`, cx, cy + (i - (m.lines.length - 1) / 2) * VERB_LINE, line, { size: VERB_SIZE, baseline: "central", owner: m.id }))
  }
  for (const route of layout.edges) {
    const r = relationOf(route.id)
    const name = `${clean(r.verb)} (${r.from} → ${r.to})`
    if (notation === "chen") {
      const child = route.id.endsWith(":c")
      if (child && !r.optional) {
        // tham gia toàn phần: đường đôi
        const m = diamondOf.get(r.id)!
        const horizontalStart = route.points[0][1] === route.points[1][1]
        const trim = 2.2 * (horizontalStart ? m.hw / m.hh : m.hh / m.hw)
        scene.polyline(`${route.id}`, trimStart(offsetPath(route.points, 2.2), -trim), { name })
        scene.polyline(`${route.id}2`, trimStart(offsetPath(route.points, -2.2), -trim), { name })
      } else scene.polyline(route.id, route.points, { name })
    } else {
      scene.polyline(route.id, route.points, { name, dashed: notation === "idef1x" && r.identifying !== true })
      for (const e of edgeEnds(route)) if (e.kind) drawEnd(scene, route.id, endOf(route.points, e.index), e.index, notation, e.kind)
    }
  }
  for (const req of requests) {
    const center = centers.get(req.id)!
    if (req.id.endsWith("#label")) {
      const r = relationOf(req.edge)
      scene.labelBlock(req.edge, wrapLines(clean(r.verb), VERB_SIZE, MAX_VERB_WIDTH, 2), center, { size: VERB_SIZE, lineHeight: VERB_LINE })
    } else {
      const route = layout.edges.find((e) => e.id === req.edge)!
      const e = edgeEnds(route)[notation === "chen" ? 0 : 1]
      if (e.letter) scene.text(req.id, center[0], center[1], e.letter, { size: CARD_SIZE, baseline: "central", owner: req.edge })
    }
  }
  return scene
}

const drawEntity = (scene: Scene, e: EntityBox, placed: PlacedNode, notation: ErdNotation): void => {
  const { id, name } = e.input
  const { x, y, w, h } = placed.body
  const rounded = notation === "idef1x" && e.input.dependent === true
  scene.rect(id, x, y, w, h, { name, ...(rounded ? { radius: 10 } : {}) })
  e.nameLines.forEach((line, i) => scene.text(`${id}#name-${i}`, x + w / 2, y + e.headerH / 2 + (i - (e.nameLines.length - 1) / 2) * NAME_LINE, line, { size: NAME_SIZE, bold: true, baseline: "central", owner: id }))
  if (e.rows.length > 0) {
    scene.decoration(`${id}#rule-0`, id, [[x, y + e.headerH], [x + w, y + e.headerH]])
    let cursor = y + e.headerH + 6
    e.rows.forEach((row, i) => {
      if (row.gapBefore) {
        cursor += 4
        scene.decoration(`${id}#rule-${i + 1}`, id, [[x, cursor], [x + w, cursor]])
        cursor += 4
      }
      scene.text(`${id}#attr-${i}`, x + 10, cursor + ATTR_LINE / 2, row.text, { size: ATTR_SIZE, bold: row.pk, anchor: "start", baseline: "central", owner: id })
      cursor += ATTR_LINE
    })
  }
  // Chen: thuộc tính là ô-van dưới hộp, nối bằng đoạn thẳng; thuộc tính khoá gạch chân
  if (e.ovals.length > 0) {
    const total = e.ovals.reduce((sum, v) => sum + 2 * v.rx, 0) + (e.ovals.length - 1) * 10
    let left = placed.rect.x + (placed.rect.w - total) / 2
    const cy = y + h + 24 + 13
    e.ovals.forEach((v, i) => {
      const ovalId = `${id}.attr-${i}`
      const cx = left + v.rx
      scene.ellipse(ovalId, cx, cy, v.rx, v.ry, { name: v.name })
      scene.text(`${ovalId}#name`, cx, cy, v.name, { size: ATTR_SIZE, bold: v.pk, baseline: "central", owner: ovalId })
      if (v.pk) {
        const half = textWidth(v.name, ATTR_SIZE, true) / 2
        scene.decoration(`${ovalId}#key`, ovalId, [[cx - half, cy + 8], [cx + half, cy + 8]])
      }
      scene.line(`${ovalId}#link`, [x + (w * (i + 1)) / (e.ovals.length + 1), y + h], [cx, cy - v.ry], { name: `${name} — ${v.name}` })
      left += 2 * v.rx + 10
    })
  }
}
