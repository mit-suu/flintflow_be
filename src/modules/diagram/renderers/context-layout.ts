/**
 * Hình học sơ đồ ngữ cảnh (DFD mức 0). Hệ thống là vòng tròn ở gốc toạ độ; actor quây quanh theo cung vai trò:
 * người dùng bên trái (west), hệ thống ngoài bên phải (east), bộ hẹn giờ phía dưới (south); phía trên (north)
 * chỉ dùng khi một cột quá cao. Đơn vị point, trục y hướng lên (đúng quy ước `pos` của Graphviz).
 *
 * Mỗi mũi tên gồm hai đoạn nối tiếp, tiếp tuyến nhau tại điểm nối:
 * - đoạn THẲNG từ cổng trên mặt hộp quay vào tâm, đủ dài để chứa trọn nhãn của nó;
 * - đoạn CONG bậc ba từ cuối đoạn thẳng, điều khiển bởi khuỷu Q (nằm trên một ellipse bao ngoài vòng tròn) và
 *   C2 trên đoạn QP3, tới cổng P3 trên vòng tròn = chiếu hướng tâm của Q.
 * Đa giác điều khiển của đoạn cong lồi nên không uốn chữ S; bao lồi nằm trong nửa mặt phẳng {p·n ≥ r} với
 * n = Q/|Q| nên không đâm vào vòng tròn. Góc của tia tăng đơn điệu theo khoảng cách tới trục, nên các mũi tên
 * cùng cung không cắt nhau.
 */

export type ActorKind = "human" | "system" | "time"
export type FlowDirection = "in" | "out"
export type ContextSector = "west" | "east" | "south" | "north"
export type Point = { x: number; y: number }
export type Size = { width: number; height: number }

/** Danh sách nhãn đã chuẩn hoá và đã giới hạn; chuỗi rỗng = mũi tên không nhãn. */
export interface ContextActor {
  id: string
  name: string
  kind: ActorKind
  /** actor → hệ thống */
  inbound: readonly string[]
  /** hệ thống → actor */
  outbound: readonly string[]
}
export interface PositionedActor extends ContextActor {
  sector: ContextSector
  center: Point
  width: number
  height: number
}
export interface ContextEdge {
  actorId: string
  flow: FlowDirection
  /** Vị trí trong danh sách cùng chiều (`inbound` hoặc `outbound`). */
  index: number
  text: string
  /** Chuỗi Bézier bậc ba theo chiều vẽ (3n+1 điểm): điểm đầu là đuôi mũi tên, điểm cuối là đầu mũi tên. */
  path: Point[]
  /** `null` khi mũi tên không nhãn. */
  labelPoint: Point | null
  labelSize: Size | null
}
export interface ContextLayout {
  /** Hệ thống luôn là hình tròn: hai bán kính bằng nhau. */
  radiusX: number
  radiusY: number
  actors: PositionedActor[]
  edges: ContextEdge[]
  /** Khung bao gồm vòng tròn, hộp, nhãn và đường cong. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

const LABEL_FONT = 12
const NAME_FONT = 14
const CHAR_W = LABEL_FONT * 0.65
const LABEL_WRAP = 26
/** Tên actor gói hẹp hơn nhãn: Word thu ảnh về khổ trang, chiều rộng quyết định cỡ chữ. */
const NAME_WRAP = 18
const PORT_MIN_BAND = 18
const BAND_GAP = 8
const PORT_INSET = 10
const LABEL_MARGIN = 20
const KNEE = 32
const KNEE_AXIS_MIN = 36
const ACTOR_GAP = 28
const DEG = Math.PI / 180
const SECTOR_GAP = 10 * DEG
const COLUMN_FREE_BOUND = 70 * DEG
const ROW_BOUND = 50 * DEG
const MIN_BOUND = 20 * DEG
const KNEE_SPAN_FACTOR = 1.12
const PORT_MIN_GAP = 9
/** Bề ngang tối đa so với chiều cao; bè hơn thì giãn cột theo chiều dọc. Gọn quan trọng hơn đúng 4:3. */
const ASPECT = 1.6
const SPREAD_STEP = 8
const SPREAD_MAX = 120
const BALANCE_RATIO = 1.6
const C2_RATIO = 0.55
const MAX_SOUTH = 2
const MAX_NORTH = 3

/** Gói dòng chỉ đổi cách trình bày: một nhãn vẫn là một mũi tên. */
export const contextLabelLines = (text: string, limit = LABEL_WRAP): string[] => {
  const lines: string[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1
    if (last >= 0 && lines[last].length + word.length + 1 <= limit) lines[last] += ` ${word}`
    else lines.push(word)
  }
  return lines.length ? lines : [""]
}

const textWidth = (lines: string[], font: number): number => Math.max(...lines.map((l) => l.length)) * font * 0.65
const labelSize = (text: string): Size => {
  if (text === "") return { width: 0, height: 0 }
  const lines = contextLabelLines(text)
  return { width: Math.max(...lines.map((l) => l.length)) * CHAR_W + 10, height: lines.length * 18 + 4 }
}

type Arrow = { flow: FlowDirection; index: number; text: string; size: Size }
interface Metrics {
  actor: ContextActor
  arrows: Arrow[]
  nameW: number
  nameH: number
}
const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0)

const metricsOf = (a: ContextActor): Metrics => {
  const arrows: Arrow[] = [
    ...a.inbound.map((text, index) => ({ flow: "in" as const, index, text, size: labelSize(text) })),
    ...a.outbound.map((text, index) => ({ flow: "out" as const, index, text, size: labelSize(text) }))
  ]
  const name = contextLabelLines(a.name, NAME_WRAP)
  return { actor: a, arrows, nameW: Math.max(104, textWidth(name, NAME_FONT) + 28), nameH: name.length * 20 + 24 }
}

/** Cột (trái/phải): các mũi tên toả theo phương dọc; hàng (trên/dưới): toả theo phương ngang. */
const colBands = (m: Metrics): number[] => m.arrows.map((a) => Math.max(PORT_MIN_BAND, a.size.height + BAND_GAP))
const rowBands = (m: Metrics): number[] => m.arrows.map((a) => Math.max(PORT_MIN_BAND, a.size.width + BAND_GAP))
const colSize = (m: Metrics): Size => ({ width: m.nameW, height: Math.max(m.nameH, sum(colBands(m)) + 2 * PORT_INSET) })
const rowSize = (m: Metrics): Size => ({ width: Math.max(m.nameW, sum(rowBands(m)) + 2 * PORT_INSET), height: m.nameH })
/** Toạ độ của từng cổng dọc trục toả, tính từ tâm hộp; phần tử đầu ở đầu dương nhân với `sign`. */
const fanOffsets = (bands: number[], sign: 1 | -1): number[] => {
  const total = sum(bands)
  let cursor = 0
  return bands.map((b) => {
    const offset = total / 2 - (cursor + b / 2)
    cursor += b
    return sign * offset
  })
}

const columnExtent = (ms: Metrics[]): number =>
  ms.length === 0 ? 0 : sum(ms.map((m) => colSize(m).height)) + (ms.length - 1) * ACTOR_GAP

/** Chia cung theo vai trò, rồi cân lại khi một cung trống hoặc một cột quá cao. Tất định: đi theo thứ tự id. */
const assignSectors = (ms: Metrics[], radius: number): Record<ContextSector, Metrics[]> => {
  const s: Record<ContextSector, Metrics[]> = {
    west: ms.filter((m) => m.actor.kind === "human"),
    east: ms.filter((m) => m.actor.kind === "system"),
    south: ms.filter((m) => m.actor.kind === "time"),
    north: []
  }
  const half = (xs: Metrics[]) => Math.ceil(xs.length / 2)
  if (s.west.length === 0 && s.east.length === 0 && s.south.length >= 2) {
    s.west = s.south.slice(0, half(s.south))
    s.east = s.south.slice(half(s.south))
    s.south = []
  } else if (s.west.length === 0 && s.east.length >= 2) {
    s.west = s.east.slice(half(s.east))
    s.east = s.east.slice(0, half(s.east))
  } else if (s.east.length === 0 && s.west.length >= 2) {
    s.east = s.west.slice(half(s.west))
    s.west = s.west.slice(0, half(s.west))
  }
  // Hàng dưới chỉ nhận ít actor đủ hẹp; dư dồn xuống cuối cột ngắn hơn
  const rowMax = 2 * (radius + KNEE)
  const keep: Metrics[] = []
  for (const m of s.south) {
    if (keep.length < MAX_SOUTH && rowSize(m).width <= rowMax) keep.push(m)
    else (columnExtent(s.east) < columnExtent(s.west) ? s.east : s.west).push(m)
  }
  s.south = keep
  // Cân hai cột: chuyển actor cuối của cột nặng sang cột nhẹ khi cột nặng cao vượt hẳn
  for (let guard = 0; guard < ms.length; guard++) {
    const [heavy, light] = columnExtent(s.west) >= columnExtent(s.east) ? [s.west, s.east] : [s.east, s.west]
    if (heavy.length < 2) break
    if (columnExtent(heavy) <= BALANCE_RATIO * Math.max(columnExtent(light), 2 * (radius + KNEE))) break
    const moved = heavy[heavy.length - 1]
    const after = Math.max(columnExtent(heavy.slice(0, -1)), columnExtent([...light, moved]))
    if (after >= Math.max(columnExtent(heavy), columnExtent(light))) break
    light.push(heavy.pop()!)
  }
  // Tràn lên phía trên khi cột vẫn quá cao so với bề ngang ước tính
  const estWidth = 2 * (radius + KNEE + 120 + Math.max(104, ...ms.map((m) => m.nameW)))
  for (let guard = 0; guard < MAX_NORTH; guard++) {
    const tall = columnExtent(s.west) >= columnExtent(s.east) ? s.west : s.east
    if (Math.max(columnExtent(s.west), columnExtent(s.east)) <= 1.1 * estWidth || tall.length < 2) break
    if (rowSize(tall[0]).width > rowMax) break
    const moved = tall.shift()!
    if (tall === s.west) s.north.unshift(moved)
    else s.north.push(moved)
  }
  return s
}

/** Ellipse khuỷu cho một nửa cung: `base` theo phương pháp tuyến, `extent` = |toạ độ| xa nhất dọc trục toả. */
const kneeEllipse = (base: number, extent: number, bound: number) => {
  const reach = extent / Math.tan(bound)
  const normal = reach > 0.95 * base ? reach / 0.95 : base
  const ratio = Math.min(reach / normal, 0.999)
  const along = Math.max(normal, KNEE_SPAN_FACTOR * extent, extent / Math.sqrt(1 - ratio * ratio), 1)
  return (pos: number): number => Math.max(KNEE_AXIS_MIN, normal * Math.sqrt(Math.max(0, 1 - (pos / along) ** 2)))
}

/**
 * Khoảng cách khuỷu (theo phương pháp tuyến) cho các cổng trong một nửa cung. Mỗi khuỷu ít nhất bằng `floor`
 * của nó; sau đó một lượt sửa đi từ cổng xa trục vào gần trục: cổng sau phải nhỏ góc hơn cổng trước ít nhất
 * PORT_MIN_GAP/r. Chỉ đẩy khuỷu ra xa, không kéo vào — góc vẫn tăng đơn điệu theo khoảng cách tới trục.
 */
const kneeOffsets = (positions: number[], curve: (pos: number) => number, floor: (pos: number) => number, radius: number): number[] => {
  const offsets = positions.map((p) => Math.max(curve(p), floor(p)))
  const order = positions.map((_, i) => i).sort((a, b) => Math.abs(positions[b]) - Math.abs(positions[a]))
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1], cur = order[k]
    if (positions[cur] === 0) continue
    const limit = Math.atan2(Math.abs(positions[prev]), offsets[prev]) - PORT_MIN_GAP / radius
    if (Math.atan2(Math.abs(positions[cur]), offsets[cur]) > limit) {
      offsets[cur] = limit > 1e-6 ? Math.abs(positions[cur]) / Math.tan(limit) : offsets[cur] + PORT_MIN_GAP
    }
  }
  return offsets
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

interface Port {
  metrics: Metrics
  arrow: Arrow
  /** Cổng trên mặt hộp. */
  port: Point
  /** Khuỷu. */
  knee: Point
  /** Độ dài đoạn thẳng (≤ |khuỷu − cổng|), đủ chứa nhãn. */
  leg: number
  /** Tâm nhãn, nằm trên đoạn thẳng. */
  labelAt: Point
}

const edgeOf = ({ port, knee, arrow, metrics, leg, labelAt }: Port, radius: number): ContextEdge => {
  const length = Math.hypot(knee.x, knee.y)
  const sys = { x: (radius * knee.x) / length, y: (radius * knee.y) / length }
  const c2 = lerp(sys, knee, C2_RATIO)
  const span = Math.hypot(knee.x - port.x, knee.y - port.y)
  const joint = span > 0 ? lerp(port, knee, Math.min(1, leg / span)) : port
  // Đoạn thẳng cổng → điểm nối, rồi đoạn cong điểm nối → vòng tròn (tiếp tuyến tại điểm nối)
  const inward = [port, lerp(port, joint, 1 / 3), lerp(port, joint, 2 / 3), joint, knee, c2, sys]
  return {
    actorId: metrics.actor.id,
    flow: arrow.flow,
    index: arrow.index,
    text: arrow.text,
    path: arrow.flow === "in" ? inward : [...inward].reverse(),
    labelPoint: arrow.text === "" ? null : labelAt,
    labelSize: arrow.text === "" ? null : arrow.size
  }
}

interface Placed {
  actors: PositionedActor[]
  edges: ContextEdge[]
}

/** Vùng một hàng chiếm: nửa bề rộng lớn nhất và mép gần vòng tròn nhất (theo |y|). */
interface RowFootprint {
  halfWidth: number
  nearest: number
  /** |y| xa nhất của hàng (mép ngoài của hộp). */
  depth: number
  /** Góc lớn nhất (tính từ trục dọc) của phần mũi tên đi vào vòng tròn. */
  angle: number
}

/** Hàng trên/dưới: xếp ngang giữa trục, khuỷu trên ellipse dọc, hộp nằm ngoài khuỷu một đoạn chân. */
const buildRow = (members: Metrics[], sector: "south" | "north", radius: number): Placed & { footprint: RowFootprint | null } => {
  if (members.length === 0) return { actors: [], edges: [], footprint: null }
  const sign = sector === "north" ? 1 : -1
  const sizes = members.map(rowSize)
  const total = sum(sizes.map((s) => s.width)) + (members.length - 1) * ACTOR_GAP
  let cursor = -total / 2
  const centersX = sizes.map((s) => {
    const x = cursor + s.width / 2
    cursor += s.width + ACTOR_GAP
    return x
  })
  const ports = members.flatMap((m, i) => fanOffsets(rowBands(m), -1).map((dx, k) => ({ m, k, x: centersX[i] + dx })))
  const extent = Math.max(...sizes.map((s, i) => Math.abs(centersX[i]) + s.width / 2))
  const curve = kneeEllipse(radius + KNEE, extent, ROW_BOUND)
  const offsets = new Array<number>(ports.length)
  for (const side of [1, -1]) {
    const idx = ports.map((_, i) => i).filter((i) => (side === 1 ? ports[i].x >= 0 : ports[i].x < 0))
    kneeOffsets(idx.map((i) => ports[i].x), curve, () => 0, radius).forEach((o, j) => (offsets[idx[j]] = o))
  }
  const leg = Math.max(36, ...members.flatMap((m) => m.arrows.map((a) => a.size.height + 2 * LABEL_MARGIN)))
  const actors: PositionedActor[] = []
  const edges: ContextEdge[] = []
  members.forEach((m, i) => {
    const mine = ports.map((p, j) => ({ ...p, off: offsets[j] })).filter((p) => p.m === m)
    const inner = (mine.length ? Math.max(...mine.map((p) => p.off)) : radius + KNEE) + leg
    const center = { x: centersX[i], y: sign * (inner + sizes[i].height / 2) }
    actors.push({ ...m.actor, sector, center, width: sizes[i].width, height: sizes[i].height })
    for (const p of mine) {
      const arrow = m.arrows[p.k]
      const labelAt = { x: p.x, y: sign * (inner - LABEL_MARGIN - arrow.size.height / 2) }
      edges.push(edgeOf({ metrics: m, arrow, port: { x: p.x, y: sign * inner }, knee: { x: p.x, y: sign * p.off }, leg, labelAt }, radius))
    }
  })
  let halfWidth = 0
  for (const a of actors) halfWidth = Math.max(halfWidth, Math.abs(a.center.x) + a.width / 2)
  for (const e of edges) if (e.labelPoint && e.labelSize) halfWidth = Math.max(halfWidth, Math.abs(e.labelPoint.x) + e.labelSize.width / 2)
  // Chân dọc của các mũi tên hàng chạy từ khuỷu gần vòng tròn nhất trở ra
  const nearest = Math.min(...offsets)
  // Góc tính cả hộp và nhãn: đường của cột phải đi ngoài mọi phần tử của hàng
  const corners: Point[] = edges.flatMap((e) => e.path)
  for (const a of actors) for (const dx of [-1, 1]) for (const dy of [-1, 1]) corners.push({ x: a.center.x + (dx * a.width) / 2, y: a.center.y + (dy * a.height) / 2 })
  for (const e of edges) if (e.labelPoint && e.labelSize) for (const dx of [-1, 1]) for (const dy of [-1, 1]) corners.push({ x: e.labelPoint.x + (dx * e.labelSize.width) / 2, y: e.labelPoint.y + (dy * e.labelSize.height) / 2 })
  const angle = Math.max(0, ...corners.map((p) => Math.atan2(Math.abs(p.x), Math.abs(p.y))))
  const depth = Math.max(...actors.map((a) => Math.abs(a.center.y) + a.height / 2))
  return { actors, edges, footprint: { halfWidth, nearest, depth, angle } }
}

/** Cột trái/phải: xếp dọc giữa trục với khoảng giãn `spread`, khuỷu trên ellipse ngang. */
const buildColumn = (
  members: Metrics[],
  sector: "west" | "east",
  radius: number,
  rows: { north: RowFootprint | null; south: RowFootprint | null },
  spread: number
): Placed => {
  if (members.length === 0) return { actors: [], edges: [] }
  const sign = sector === "east" ? 1 : -1
  const sizes = members.map(colSize)
  const gap = ACTOR_GAP + spread
  let cursor = (sum(sizes.map((s) => s.height)) + (members.length - 1) * gap) / 2
  const centersY = sizes.map((s) => {
    const y = cursor - s.height / 2
    cursor -= s.height + gap
    return y
  })
  // Có hàng dưới (mà không có hàng trên) thì nâng cột vừa đủ để đáy cột không thấp hơn đáy hàng dưới, và ngược
  // lại: cổng cột nằm càng sâu vào vùng của hàng thì càng phải đẩy ngang xa mới giữ được góc tách cung
  const lowest = Math.min(...sizes.map((s, i) => centersY[i] - s.height / 2))
  const highest = Math.max(...sizes.map((s, i) => centersY[i] + s.height / 2))
  const shift =
    rows.south && !rows.north ? Math.max(0, -rows.south.depth - lowest)
    : rows.north && !rows.south ? -Math.max(0, highest - rows.north.depth)
    : 0
  for (let i = 0; i < centersY.length; i++) centersY[i] += shift
  const ports = members.flatMap((m, i) => fanOffsets(colBands(m), 1).map((dy, k) => ({ m, k, y: centersY[i] + dy })))
  const offsets = new Array<number>(ports.length)
  for (const side of [1, -1]) {
    const row = side === 1 ? rows.north : rows.south
    const bound = row ? Math.max(MIN_BOUND, Math.PI / 2 - row.angle - SECTOR_GAP) : COLUMN_FREE_BOUND
    const extent = Math.max(0, ...sizes.map((s, i) => side * centersY[i] + s.height / 2))
    const curve = kneeEllipse(radius + KNEE, extent, bound)
    // Khuỷu ngang tầm hàng trên/dưới phải nằm ngoài bề rộng của hàng đó
    const floor = (pos: number) => (row && Math.abs(pos) >= row.nearest - ACTOR_GAP ? row.halfWidth + ACTOR_GAP : 0)
    const idx = ports.map((_, i) => i).filter((i) => (side === 1 ? ports[i].y >= 0 : ports[i].y < 0))
    kneeOffsets(idx.map((i) => ports[i].y), curve, floor, radius).forEach((o, j) => (offsets[idx[j]] = o))
  }
  const leg = Math.max(36, ...members.flatMap((m) => m.arrows.map((a) => a.size.width + 2 * LABEL_MARGIN)))
  const actors: PositionedActor[] = []
  const edges: ContextEdge[] = []
  members.forEach((m, i) => {
    const mine = ports.map((p, j) => ({ ...p, off: offsets[j] })).filter((p) => p.m === m)
    const inner = (mine.length ? Math.max(...mine.map((p) => p.off)) : radius + KNEE) + leg
    const center = { x: sign * (inner + sizes[i].width / 2), y: centersY[i] }
    actors.push({ ...m.actor, sector, center, width: sizes[i].width, height: sizes[i].height })
    for (const p of mine) {
      const arrow = m.arrows[p.k]
      const labelAt = { x: sign * (inner - LABEL_MARGIN - arrow.size.width / 2), y: p.y }
      edges.push(edgeOf({ metrics: m, arrow, port: { x: sign * inner, y: p.y }, knee: { x: sign * p.off, y: p.y }, leg, labelAt }, radius))
    }
  })
  return { actors, edges }
}

const boundsOf = (radius: number, placed: Placed): ContextLayout["bounds"] => {
  let minX = -radius, maxX = radius, minY = -radius, maxY = radius
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  for (const a of placed.actors) {
    add(a.center.x - a.width / 2, a.center.y - a.height / 2)
    add(a.center.x + a.width / 2, a.center.y + a.height / 2)
  }
  for (const e of placed.edges) {
    for (const p of e.path) add(p.x, p.y)
    if (e.labelPoint && e.labelSize) {
      add(e.labelPoint.x - e.labelSize.width / 2, e.labelPoint.y - e.labelSize.height / 2)
      add(e.labelPoint.x + e.labelSize.width / 2, e.labelPoint.y + e.labelSize.height / 2)
    }
  }
  return { minX, minY, maxX, maxY }
}

export const buildContextLayout = (actors: readonly ContextActor[], systemName = "System"): ContextLayout => {
  const title = contextLabelLines(systemName)
  const baseRadius = Math.max(100, textWidth(title, 18) / 2 + 24, title.length * 12 + 24)
  const metrics = actors.map(metricsOf)
  const sectors = assignSectors(metrics, baseRadius)
  const busiest = Math.max(0, ...(["west", "east"] as const).map((s) => sum(sectors[s].map((m) => m.arrows.length))))
  const radius = Math.max(baseRadius, (busiest * PORT_MIN_GAP) / 1.6)

  const south = buildRow(sectors.south, "south", radius)
  const north = buildRow(sectors.north, "north", radius)
  const rows = { south: south.footprint, north: north.footprint }
  const tall = sectors.west.length >= 2 || sectors.east.length >= 2
  let placed: Placed = { actors: [], edges: [] }
  let best: { placed: Placed; ratio: number } | null = null
  for (let spread = 0; spread <= (tall ? SPREAD_MAX : 0); spread += SPREAD_STEP) {
    const west = buildColumn(sectors.west, "west", radius, rows, spread)
    const east = buildColumn(sectors.east, "east", radius, rows, spread)
    placed = {
      actors: [...west.actors, ...east.actors, ...south.actors, ...north.actors],
      edges: [...west.edges, ...east.edges, ...south.edges, ...north.edges]
    }
    const b = boundsOf(radius, placed)
    const ratio = (b.maxX - b.minX) / (b.maxY - b.minY)
    // Dừng ngay khi đủ gọn; giãn thêm có thể làm cột bị đẩy ra xa, nên cũng dừng khi bắt đầu tệ đi
    if (!best || ratio < best.ratio) best = { placed, ratio }
    else break
    if (ratio <= ASPECT) break
  }
  placed = best?.placed ?? placed
  const byId = new Map(placed.actors.map((a) => [a.id, a]))
  return {
    radiusX: radius,
    radiusY: radius,
    actors: actors.map((a) => byId.get(a.id)!),
    edges: placed.edges,
    bounds: boundsOf(radius, placed)
  }
}
