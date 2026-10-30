/**
 * class-layout.ts
 * ─────────────────────────────────────────────────────────────────
 * Class diagram mức phân tích (domain) dựng bằng SVG — UML 2.5.1 class, IEEE 830 Annex A.3 (tổ chức theo đối tượng).
 * Dùng lại bộ xếp lưới + đi đường vuông góc của ERD (`orthogonal-place.ts`, `orthogonal-route.ts`, `orthogonal-ends.ts`).
 *
 * Hộp class hai ngăn: tên (đậm, giữa) / thuộc tính. Không có ngăn thao tác và không có kiểu dữ liệu — đó là mức thiết
 * kế của Report 4 (IEEE 1016). Class không có thuộc tính chỉ có ngăn tên. Thuộc tính in `name`, kèm `{id}` (định danh),
 * `{ref}` (tham chiếu tới class khác) và `[0..1]` khi không bắt buộc.
 *
 * Quan hệ: association (nét liền, không mũi tên) có bản số hai đầu và tên quan hệ trên đường; aggregation (thoi rỗng ở
 * phía tổng thể), composition (thoi đặc), generalization (tam giác rỗng về class cha, không bản số / tên). Spine hiện chỉ
 * có dữ liệu cho association — ba loại sau vẽ được nhưng renderer chỉ sinh khi nguồn nói rõ.
 *
 * Mọi hình tô `#7ACFF5`, viền / chữ đen.
 */

import { textWidth, type Point } from "../../../shared/diagram/svg-kit.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"
import { endOf, endSpots, verbSpots, zoneRect } from "./orthogonal-ends.js"
import { placeOnGrid } from "./orthogonal-place.js"
import { DEFAULT_ROUTE_OPTIONS, placeLabels, routeOnGrid, type GridEdge, type GridLayout, type GridNode, type LabelRequest, type PlacedNode, type Rect } from "./orthogonal-route.js"
import { wrapLines } from "./usecase-layout.js"

export type ClassAttributeKind = "key" | "reference" | "plain"

export interface ClassAttributeInput {
  name: string
  kind: ClassAttributeKind
  required: boolean
}

export interface ClassNodeInput {
  id: string
  name: string
  attributes: readonly ClassAttributeInput[]
}

export type ClassRelationKind = "association" | "aggregation" | "composition" | "generalization"

export interface ClassRelationInput {
  /** Id ổn định theo Spine, vd `E01>E02`. */
  id: string
  /**
   * Đầu `from`: association — phía một (cha); aggregation / composition — phía tổng thể (mang thoi); generalization — class
   * con (đầu `to` là class cha, mang tam giác).
   */
  from: string
  to: string
  kind: ClassRelationKind
  /** Tên quan hệ trên đường (bỏ trống ⇒ không nhãn). */
  name: string
  /** Bản số hai đầu (`1`, `0..1`, `*`, `1..*`); generalization không có. */
  fromMultiplicity: string
  toMultiplicity: string
}

export interface ClassDiagram {
  nodes: readonly ClassNodeInput[]
  relations: readonly ClassRelationInput[]
}

const NAME_SIZE = 14
const ATTR_SIZE = 12
const NAME_LINE = 18
const ATTR_LINE = 17
const NAME_LABEL_SIZE = 12
const NAME_LABEL_LINE = 15
const MULT_SIZE = 12
const MAX_NAME_WIDTH = 170
const MAX_ATTR_WIDTH = 260
const MAX_LABEL_WIDTH = 110
const HEAD_LEG = 30
const MULT_LEG = 22
const PLAIN_LEG = 14

const clean = (text: string): string => text.replace(/\s+/g, " ").trim()

const ellipsize = (text: string, size: number, max: number): string => {
  if (textWidth(text, size) <= max) return text
  let cut = text
  while (cut.length > 1 && textWidth(`${cut}...`, size) > max) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}...`
}

/** Chữ một thuộc tính: `name`, `name {id}`, `name {ref}`, thêm ` [0..1]` khi không bắt buộc. */
export const attributeText = (a: ClassAttributeInput): string => {
  const mark = a.kind === "key" ? " {id}" : a.kind === "reference" ? " {ref}" : ""
  return ellipsize(`${clean(a.name)}${mark}${a.required ? "" : " [0..1]"}`, ATTR_SIZE, MAX_ATTR_WIDTH)
}

interface ClassBox {
  input: ClassNodeInput
  nameLines: string[]
  headerH: number
  rows: string[]
  node: GridNode
}

const classBox = (n: ClassNodeInput, degree: number, selfLoops: number): ClassBox => {
  const o = DEFAULT_ROUTE_OPTIONS
  const nameLines = wrapLines(clean(n.name) || n.id, NAME_SIZE, MAX_NAME_WIDTH, 2)
  const nameW = Math.max(...nameLines.map((l) => textWidth(l, NAME_SIZE, true)))
  const rows = n.attributes.map(attributeText)
  const headerH = Math.max(34, nameLines.length * NAME_LINE + 14)
  const attrH = rows.length > 0 ? 12 + rows.length * ATTR_LINE : 0
  const attrW = Math.max(0, ...rows.map((r) => textWidth(r, ATTR_SIZE)))
  const slots = Math.max(1, Math.ceil((degree - 2 * selfLoops) / 2) + 2 * selfLoops)
  const portSpan = 2 * o.portMargin + (slots - 1) * o.portPitch
  const w = Math.max(110, Math.ceil(nameW + 28), Math.ceil(attrW + 24), portSpan)
  const h = Math.max(headerH + attrH, portSpan)
  return { input: n, nameLines, headerH, rows, node: { id: n.id, w, h } }
}

const OPTIONS = { gapX: 100, gapY: 84 }

const headEnd = (r: ClassRelationInput): 0 | 1 | null => (r.kind === "aggregation" || r.kind === "composition" ? 0 : r.kind === "generalization" ? 1 : null)

const legsOf = (r: ClassRelationInput): [number, number] => {
  const head = headEnd(r)
  const plain = r.kind === "generalization" ? PLAIN_LEG : MULT_LEG
  return [head === 0 ? HEAD_LEG : plain, head === 1 ? HEAD_LEG : plain]
}

const edgeIdOf = (r: ClassRelationInput): string => `R:${r.id}`

interface Plan {
  layout: GridLayout
  centers: Map<string, Point>
  requests: LabelRequest[]
}

/** Scene của một hình class diagram; `null` khi không tìm được đường cho mọi cạnh dù nới khe (người gọi tách hình). */
export const layoutClass = (d: ClassDiagram): Scene | null => {
  const known = new Set(d.nodes.map((n) => n.id))
  const relations = d.relations.filter((r) => known.has(r.from) && known.has(r.to))
  const degree = new Map<string, number>()
  const selfLoops = new Map<string, number>()
  for (const r of relations) {
    for (const id of [r.from, r.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
    if (r.from === r.to) selfLoops.set(r.from, (selfLoops.get(r.from) ?? 0) + 1)
  }
  const boxes = d.nodes.map((n) => classBox(n, degree.get(n.id) ?? 0, selfLoops.get(n.id) ?? 0))
  const relationOf = new Map(relations.map((r) => [edgeIdOf(r), r]))
  const edges: GridEdge[] = relations.map((r) => ({ id: edgeIdOf(r), from: r.from, to: r.to, endLeg: legsOf(r) }))
  // cha → con cho bộ xếp hạng: generalization có cha ở đầu `to`
  const links: [string, string][] = relations.map((r) => (r.kind === "generalization" ? [r.to, r.from] : [r.from, r.to]))
  const nodes = boxes.map((b) => b.node)
  const cells = placeOnGrid(nodes.map((n) => n.id), links, Math.max(3, Math.round(Math.sqrt(nodes.length * 1.8))))

  const plan = (layout: GridLayout): Plan | null => {
    const avoid: Rect[] = [...layout.nodes.values()].map((n) => ({ x: n.rect.x - 2, y: n.rect.y - 2, w: n.rect.w + 4, h: n.rect.h + 4 }))
    const requests: LabelRequest[] = []
    for (const route of [...layout.edges].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const r = relationOf.get(route.id)!
      const head = headEnd(r)
      const mults: [0 | 1, string][] = r.kind === "generalization" ? [] : [[0, r.fromMultiplicity], [1, r.toMultiplicity]]
      for (const index of [0, 1] as const) if (head === index) avoid.push(zoneRect(endOf(route.points, index), 20, 8))
      for (const [index, text] of mults) {
        const w = textWidth(text, MULT_SIZE) + 4
        requests.push({ id: `${route.id}#m${index}`, edge: route.id, w, h: 16, spots: endSpots(endOf(route.points, index), w, 16, 4) })
      }
      if (r.kind !== "generalization" && clean(r.name)) {
        const lines = wrapLines(clean(r.name), NAME_LABEL_SIZE, MAX_LABEL_WIDTH, 2)
        const w = Math.max(...lines.map((l) => textWidth(l, NAME_LABEL_SIZE))) + 8
        const h = lines.length * NAME_LABEL_LINE + 4
        requests.push({ id: `${route.id}#label`, edge: route.id, w, h, spots: verbSpots(route.points, w, h) })
      }
    }
    const centers = placeLabels(requests, layout.edges, avoid)
    return centers ? { layout, centers, requests } : null
  }

  const holder: { plan: Plan | null } = { plan: null }
  const layout = routeOnGrid(nodes, edges, cells, { ...DEFAULT_ROUTE_OPTIONS, ...OPTIONS }, (l) => ((holder.plan = plan(l)), holder.plan !== null))
  if (!layout || !holder.plan) return null
  const { centers, requests } = holder.plan

  const scene = new Scene()
  for (const b of boxes) drawClass(scene, b, layout.nodes.get(b.input.id)!)
  for (const route of layout.edges) {
    const r = relationOf.get(route.id)!
    scene.polyline(route.id, route.points, { name: `${clean(r.name) || r.kind} (${r.from} → ${r.to})` })
    if (r.kind === "aggregation") scene.arrow(route.id, "diamond", "start")
    else if (r.kind === "composition") scene.arrow(route.id, "diamond_filled", "start")
    else if (r.kind === "generalization") scene.arrow(route.id, "triangle", "end")
  }
  for (const req of requests) {
    const center = centers.get(req.id)!
    const r = relationOf.get(req.edge)!
    if (req.id.endsWith("#label")) {
      scene.labelBlock(req.edge, wrapLines(clean(r.name), NAME_LABEL_SIZE, MAX_LABEL_WIDTH, 2), center, { size: NAME_LABEL_SIZE, lineHeight: NAME_LABEL_LINE })
    } else {
      const text = req.id.endsWith("#m0") ? r.fromMultiplicity : r.toMultiplicity
      scene.text(req.id, center[0], center[1], text, { size: MULT_SIZE, baseline: "central", owner: req.edge })
    }
  }
  return scene
}

const drawClass = (scene: Scene, b: ClassBox, placed: PlacedNode): void => {
  const { id, name } = b.input
  const { x, y, w, h } = placed.body
  scene.rect(id, x, y, w, h, { name })
  b.nameLines.forEach((line, i) =>
    scene.text(`${id}#name-${i}`, x + w / 2, y + b.headerH / 2 + (i - (b.nameLines.length - 1) / 2) * NAME_LINE, line, { size: NAME_SIZE, bold: true, baseline: "central", owner: id })
  )
  if (b.rows.length === 0) return
  scene.decoration(`${id}#rule-0`, id, [[x, y + b.headerH], [x + w, y + b.headerH]])
  b.rows.forEach((row, i) => scene.text(`${id}#attr-${i}`, x + 10, y + b.headerH + 6 + i * ATTR_LINE + ATTR_LINE / 2, row, { size: ATTR_SIZE, anchor: "start", baseline: "central", owner: id }))
}
