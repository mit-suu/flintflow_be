import { describe, expect, it } from "vitest"
import { buildContextLayout, contextLabelLines, type ContextActor, type ContextEdge, type Point } from "./context-layout.js"

const actor = (id: string, count: number, long = false): ContextActor => ({
  id,
  name: long ? `External actor ${id} with a long descriptive name` : id,
  pairs: Array.from({ length: count }, (_, i) => ({
    input: long ? `Request ${i} with all the details required to update the project requirements` : `Request ${i}`,
    output: long ? `Result ${i} containing the complete updated requirements and validation status` : `Result ${i}`
  }))
})
type Segment = { start: Point; end: Point }
const range = (e: Segment, axis: "x" | "y") => [Math.min(e.start[axis], e.end[axis]), Math.max(e.start[axis], e.end[axis])]
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
const intersects = (a: Segment, b: Segment) => {
  if (!(["x", "y"] as const).every((axis) => {
    const [a0, a1] = range(a, axis), [b0, b1] = range(b, axis)
    return a0 <= b1 + 1e-8 && b0 <= a1 + 1e-8
  })) return false
  return cross(a.start, a.end, b.start) * cross(a.start, a.end, b.end) <= 1e-8
    && cross(b.start, b.end, a.start) * cross(b.start, b.end, a.end) <= 1e-8
}
const curveSegments = (e: ContextEdge): Segment[] => {
  const [b, c] = e.controls
  const points = Array.from({ length: 65 }, (_, i) => {
    const t = i / 64, u = 1 - t
    const coordinate = (axis: "x" | "y") => u ** 3 * e.start[axis] + 3 * u * u * t * b[axis]
      + 3 * u * t * t * c[axis] + t ** 3 * e.end[axis]
    return { x: coordinate("x"), y: coordinate("y") }
  })
  return points.slice(1).map((end, i) => ({ start: points[i], end }))
}

describe("context attachment geometry", () => {
  it.each([
    { name: "user's mixed diagram", counts: [5, 1, 1, 3, 1], long: false },
    { name: "one dense actor", counts: [5], long: false },
    { name: "dense actors in both columns", counts: [8, 3, 2, 6, 4], long: false },
    { name: "sparse actors on both rows", counts: [1, 1, 1, 1, 1, 1, 1, 1], long: false },
    { name: "wrapped labels across all four sides", counts: [5, 1, 1, 3, 1, 1, 2, 4, 1], long: true }
  ])("$name: separate ports, no crossings and complete pairs", ({ counts, long }) => {
    const actors = counts.map((count, i) => actor(`A${i}`, count, long))
    const before = structuredClone(actors)
    const layout = buildContextLayout(actors)
    expect(layout.radiusX).toBe(layout.radiusY)
    const paths = layout.edges.map(curveSegments)
    expect(layout.edges).toHaveLength(counts.reduce((n, c) => n + 2 * c, 0))
    expect(actors).toEqual(before)
    const systemPorts = new Set<string>()
    const actorPorts = new Set<string>()
    for (const e of layout.edges) {
      const a = layout.actors.find((a) => a.id === e.actorId)!
      const systemPort = e.flow === "in" ? e.end : e.start
      const actorPort = e.flow === "in" ? e.start : e.end
      // An S curve puts its two controls on opposite sides of the chord.
      expect(cross(e.start, e.end, e.controls[0]) * cross(e.start, e.end, e.controls[1]),
        `${e.actorId} ${e.flow} must bend to one side only`).toBeGreaterThan(0)
      expect((systemPort.x / layout.radiusX) ** 2 + (systemPort.y / layout.radiusY) ** 2).toBeCloseTo(1, 10)
      if (["left", "right"].includes(a.side)) {
        expect(Math.abs(actorPort.x - a.center.x)).toBeCloseTo(a.width / 2, 10)
        expect(Math.abs(actorPort.y - a.center.y)).toBeLessThan(a.height / 2)
      } else {
        expect(Math.abs(actorPort.y - a.center.y)).toBeCloseTo(a.height / 2, 10)
        expect(Math.abs(actorPort.x - a.center.x)).toBeLessThan(a.width / 2)
      }
      const sysKey = `${systemPort.x},${systemPort.y}`
      const actorKey = `${actorPort.x},${actorPort.y}`
      expect(systemPorts.has(sysKey)).toBe(false)
      expect(actorPorts.has(actorKey)).toBe(false)
      systemPorts.add(sysKey)
      actorPorts.add(actorKey)
      expect(e.text).toBe(actors.find((a) => a.id === e.actorId)!.pairs[e.pairIndex][e.flow === "in" ? "input" : "output"])
      for (const other of layout.actors.filter((b) => b.id !== a.id)) {
        const x0 = other.center.x - other.width / 2, x1 = other.center.x + other.width / 2
        const y0 = other.center.y - other.height / 2, y1 = other.center.y + other.height / 2
        const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
        const borders = corners.map((start, i) => ({ start, end: corners[(i + 1) % 4] }))
        const crosses = paths[layout.edges.indexOf(e)].some((segment) => borders.some((border) => intersects(segment, border)))
        expect(crosses, `${e.actorId} arrow crosses ${other.id}`).toBe(false)
      }
      for (const segment of paths[layout.edges.indexOf(e)]) {
        expect(Math.hypot(segment.start.x, segment.start.y)).toBeGreaterThanOrEqual(layout.radiusX - 1e-7)
        expect(Math.hypot(segment.end.x, segment.end.y)).toBeGreaterThanOrEqual(layout.radiusX - 1e-7)
      }
    }
    for (const a of actors) for (let i = 0; i < a.pairs.length; i++) {
      expect(layout.edges.filter((e) => e.actorId === a.id && e.pairIndex === i).map((e) => e.flow)).toEqual(["in", "out"])
    }
    for (let i = 0; i < layout.edges.length; i++) for (let j = i + 1; j < layout.edges.length; j++) {
      expect(paths[i].some((a) => paths[j].some((b) => intersects(a, b))), `curves ${i} and ${j} intersect`).toBe(false)
    }
  })

  it("wrapping preserves the complete requirement, including long words", () => {
    const text = "Export the complete SRS document with Supercalifragilisticexpialidocious metadata"
    const lines = contextLabelLines(text)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(" ")).toBe(text)
    expect(lines).toContain("Supercalifragilisticexpialidocious")
  })

  it("keeps the system compact when actor labels and fan widths grow", () => {
    for (const long of [false, true]) {
      const layout = buildContextLayout([actor("A01", 5, long), actor("A02", 1, long), actor("A03", 1, long)])
      expect(layout.radiusX).toBe(100)
      expect(layout.radiusY).toBe(100)
      expect(layout.edges.some((e) => e.start.y !== e.end.y && e.start.x !== e.end.x)).toBe(true)
    }
  })

  it("empty diagram keeps finite system dimensions and no flows", () => {
    const layout = buildContextLayout([])
    expect(layout.radiusX).toBeGreaterThan(0)
    expect(layout.radiusY).toBeGreaterThan(0)
    expect(layout.actors).toEqual([])
    expect(layout.edges).toEqual([])
  })
})
