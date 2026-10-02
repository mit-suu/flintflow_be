/** Fixed attachment points and separate lanes: the graph engine must not merge parallel arrows. */
export type ContextSide = "left" | "right" | "top" | "bottom"
export type FlowPair = { input: string; output: string }
export type Point = { x: number; y: number }
export interface ContextActor {
  id: string
  name: string
  pairs: readonly FlowPair[]
}
export interface PositionedActor extends ContextActor {
  side: ContextSide
  center: Point
  width: number
  height: number
}
export interface ContextEdge {
  actorId: string
  flow: "in" | "out"
  pairIndex: number
  text: string
  start: Point
  end: Point
  controls: [Point, Point]
  labelPoint: Point
}
export interface ContextLayout {
  radiusX: number
  radiusY: number
  actors: PositionedActor[]
  edges: ContextEdge[]
}

const LABEL_FONT_SIZE = 12
const ACTOR_FONT_SIZE = 14
const PAIR_GAP = 12
const ACTOR_GAP = 44
/** Wrapping changes typography only: one complete requirement still labels one arrow. */
export const contextLabelLines = (text: string, limit = 26): string[] => {
  const lines: string[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1
    if (last >= 0 && lines[last].length + word.length + 1 <= limit) lines[last] += ` ${word}`
    else lines.push(word)
  }
  return lines.length ? lines : [""]
}
const labelWidth = (text: string, fontSize = LABEL_FONT_SIZE): number =>
  Math.max(...contextLabelLines(text).map((l) => l.length)) * fontSize * 0.65
const labelHeight = (text: string): number => contextLabelLines(text).length * 18
const flowHeight = (text: string): number => labelHeight(text) + 20
const laneHeight = (a: ContextActor): number => a.pairs.reduce((h, p) => h + flowHeight(p.input) + flowHeight(p.output) + PAIR_GAP, 0) - PAIR_GAP
const actorWidth = (a: ContextActor): number => Math.max(104, labelWidth(a.name, ACTOR_FONT_SIZE) + 28)

const sidesOf = (actors: readonly ContextActor[]): Map<string, ContextSide> => {
  const sides = new Map<string, ContextSide>()
  const counts = { left: 0, right: 0, top: 0, bottom: 0 }
  for (const a of actors) {
    const side = a.pairs.length < 2
      ? (counts.top <= counts.bottom ? "top" : "bottom")
      : (counts.left <= counts.right ? "left" : "right")
    sides.set(a.id, side)
    counts[side] += a.pairs.length
  }
  return sides
}

/** Geometry and pinned DOT positions are in points; only shape dimensions convert to inches. */
export const buildContextLayout = (actors: readonly ContextActor[], systemName = "System"): ContextLayout => {
  const sides = sidesOf(actors)
  const groups = (side: ContextSide) => actors.filter((a) => sides.get(a.id) === side)
  const sideSpan = (side: "left" | "right") => groups(side).reduce((sum, a) => sum + laneHeight(a) + 24 + ACTOR_GAP, -ACTOR_GAP)
  const sparse = (side: "top" | "bottom") => {
    const entries = groups(side).map((a) => {
      const width = Math.max(...a.pairs.flatMap((p) => [labelWidth(p.input), labelWidth(p.output)]))
      const portOffset = (width + 28) / 2
      const slotWidth = Math.max(actorWidth(a), portOffset * 2 + width + 44)
      return { actor: a, portOffset, slotWidth }
    })
    let cursor = -entries.reduce((sum, a) => sum + a.slotWidth, 0) / 2
    return entries.map((a) => {
      const x = cursor + a.slotWidth / 2
      cursor += a.slotWidth
      return { ...a, x }
    })
  }
  const upper = sparse("top")
  const lower = sparse("bottom")
  // The system stays a compact circle. Long labels spread the actors, not the system.
  // Increase its radius only for the title or enough attachment points to remain distinct.
  const portCount = Math.max(0, ...(["left", "right", "top", "bottom"] as const).map((side) =>
    groups(side).reduce((sum, a) => sum + a.pairs.length * 2, 0)))
  const radius = Math.max(100, portCount * 6, labelWidth(systemName, 18) / 2 + 24,
    contextLabelLines(systemName).length * 12 + 24)
  const radiusX = radius
  const radiusY = radius
  const positioned = new Map<string, PositionedActor>()
  const edges: ContextEdge[] = []
  const pushPairEdge = (a: ContextActor, pairIndex: number, flow: "in" | "out", actorPort: Point, systemPort: Point) => {
    const side = sides.get(a.id)!
    const horizontal = side === "left" || side === "right"
    const text = flow === "in" ? a.pairs[pairIndex].input : a.pairs[pairIndex].output
    // One quadratic arc, converted exactly to a cubic for DOT: no S bends or inflections.
    const bend = Math.min(28, Math.hypot(actorPort.x - systemPort.x, actorPort.y - systemPort.y) * 0.09)
    const control = { x: (actorPort.x + systemPort.x) / 2, y: (actorPort.y + systemPort.y) / 2 }
    if (horizontal) {
      control.y += (actorPort.y < 0 ? -1 : 1) * bend
      control.y = Math.sign(control.y) * Math.min(Math.abs(control.y), Math.abs(control.x) * 0.82)
    } else {
      control.x += (actorPort.x < 0 ? -1 : 1) * bend
      control.x = Math.sign(control.x) * Math.min(Math.abs(control.x), Math.abs(control.y) * 0.82)
    }
    const first = { x: actorPort.x + (control.x - actorPort.x) * 2 / 3, y: actorPort.y + (control.y - actorPort.y) * 2 / 3 }
    const second = { x: systemPort.x + (control.x - systemPort.x) * 2 / 3, y: systemPort.y + (control.y - systemPort.y) * 2 / 3 }
    const t = horizontal ? 0.3 : 0.12, u = 1 - t
    const at = (axis: "x" | "y") => u ** 3 * actorPort[axis] + 3 * u * u * t * first[axis]
      + 3 * u * t * t * second[axis] + t ** 3 * systemPort[axis]
    const labelPoint = horizontal
      ? { x: at("x"), y: at("y") + (actorPort.y < 0 ? -1 : 1) * (labelHeight(text) / 2 + 8) }
      : { x: at("x") - labelWidth(text) / 2 - 10, y: at("y") }
    edges.push({ actorId: a.id, pairIndex, flow, text, labelPoint,
      controls: flow === "in" ? [first, second] : [second, first],
      start: flow === "in" ? actorPort : systemPort, end: flow === "in" ? systemPort : actorPort })
  }

  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? -1 : 1
    const members = groups(side)
    const gap = Math.max(170, ...members.flatMap((a) => a.pairs.flatMap((p) => [labelWidth(p.input), labelWidth(p.output)]))) + 56
    let cursor = sideSpan(side) / 2
    for (const a of members) {
      const height = laneHeight(a) + 24
      const width = actorWidth(a)
      // Keep each fan inside its side's sector, including actors stacked in a column.
      const distance = Math.max(radius + gap, sideSpan(side) / 2 / 0.6)
      const center = { x: sign * (distance + width / 2), y: cursor - height / 2 }
      positioned.set(a.id, { ...a, side, width, height, center })
      let lane = center.y + laneHeight(a) / 2
      for (const [i, pair] of a.pairs.entries()) {
        for (const flow of ["in", "out"] as const) {
          const rowHeight = flowHeight(flow === "in" ? pair.input : pair.output)
          const actorY = lane - rowHeight / 2
          lane -= rowHeight
          // Compress the attachment lanes onto a separate arc of the circle.
          const y = actorY / Math.max(1, sideSpan(side) / 2) * radius * 0.62
          const x = sign * Math.sqrt(radius ** 2 - y ** 2)
          pushPairEdge(a, i, flow, { x: center.x - sign * width / 2, y: actorY }, { x, y })
        }
        lane -= PAIR_GAP
      }
      cursor -= height + ACTOR_GAP
    }
  }

  for (const [side, members] of [["top", upper], ["bottom", lower]] as const) {
    const sign = side === "top" ? 1 : -1
    const gap = Math.max(150, radiusY * 0.4, ...members.flatMap((a) => a.actor.pairs.flatMap((p) => [labelHeight(p.input) * 4, labelHeight(p.output) * 4])))
    const widestPort = Math.max(1, ...members.map((a) => Math.abs(a.x) + a.portOffset))
    const distance = Math.max(radius + gap, widestPort / 0.6,
      Math.max(sideSpan("left"), sideSpan("right")) / 2 + gap)
    for (const member of members) {
      const a = member.actor
      const width = Math.max(actorWidth(a), member.portOffset * 2 + 24)
      const height = contextLabelLines(a.name).length * 20 + 24
      const center = { x: member.x, y: sign * (distance + height / 2) }
      positioned.set(a.id, { ...a, side, width, height, center })
      for (const flow of ["in", "out"] as const) {
        const x = center.x + (flow === "in" ? -1 : 1) * member.portOffset
        const systemX = x / widestPort * radius * 0.62
        const systemY = sign * Math.sqrt(radius ** 2 - systemX ** 2)
        pushPairEdge(a, 0, flow, { x, y: center.y - sign * height / 2 }, { x: systemX, y: systemY })
      }
    }
  }
  return { radiusX, radiusY, actors: actors.map((a) => positioned.get(a.id)!), edges }
}
