import { describe, expect, it } from "vitest"
import {
  buildContextLayout,
  contextLabelLines,
  type ActorKind,
  type ContextActor,
  type ContextEdge,
  type ContextLayout,
  type Point,
  type PositionedActor
} from "./context-layout.js"

type Options = { long?: boolean; unlabelled?: boolean }
const actor = (id: string, kind: ActorKind, nIn: number, nOut: number, { long = false, unlabelled = false }: Options = {}): ContextActor => {
  const text = (word: string, i: number) =>
    unlabelled ? "" : long ? `${word} ${i} with all the details required to update the project requirements` : `${word} ${id} ${i}`
  return {
    id,
    kind,
    name: long ? `External actor ${id} with a long descriptive name` : `Actor ${id}`,
    inbound: Array.from({ length: nIn }, (_, i) => text("Input", i)),
    outbound: Array.from({ length: nOut }, (_, i) => text("Output", i))
  }
}

type Segment = { start: Point; end: Point }
type Rect = { x0: number; y0: number; x1: number; y1: number }
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
/** Các đoạn bậc ba của đường đi: [p0, c1, c2, p3]. */
const cubics = (e: ContextEdge): Point[][] =>
  Array.from({ length: (e.path.length - 1) / 3 }, (_, i) => e.path.slice(3 * i, 3 * i + 4))
const curvePoints = (e: ContextEdge, steps = 96): Point[] =>
  cubics(e).flatMap(([p0, c1, c2, p3], s) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const t = i / steps, u = 1 - t
      const at = (axis: "x" | "y") => u ** 3 * p0[axis] + 3 * u * u * t * c1[axis] + 3 * u * t * t * c2[axis] + t ** 3 * p3[axis]
      return { x: at("x"), y: at("y") }
    }).slice(s === 0 ? 0 : 1)
  )
const distanceToSegment = (p: Point, s: Segment): number => {
  const dx = s.end.x - s.start.x, dy = s.end.y - s.start.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.start.x) * dx + (p.y - s.start.y) * dy) / len2))
  return Math.hypot(p.x - (s.start.x + t * dx), p.y - (s.start.y + t * dy))
}
const curveSegments = (e: ContextEdge): Segment[] => {
  const points = curvePoints(e)
  return points.slice(1).map((end, i) => ({ start: points[i], end }))
}
const boxOf = (a: PositionedActor): Rect => ({
  x0: a.center.x - a.width / 2, x1: a.center.x + a.width / 2, y0: a.center.y - a.height / 2, y1: a.center.y + a.height / 2
})
const labelRect = (e: ContextEdge): Rect | null =>
  e.labelPoint && e.labelSize
    ? { x0: e.labelPoint.x - e.labelSize.width / 2, x1: e.labelPoint.x + e.labelSize.width / 2, y0: e.labelPoint.y - e.labelSize.height / 2, y1: e.labelPoint.y + e.labelSize.height / 2 }
    : null
const overlap = (a: Rect, b: Rect, pad = 0) => a.x0 < b.x1 - pad && b.x0 < a.x1 - pad && a.y0 < b.y1 - pad && b.y0 < a.y1 - pad
const inside = (p: Point, r: Rect, pad = 0) => p.x > r.x0 + pad && p.x < r.x1 - pad && p.y > r.y0 + pad && p.y < r.y1 - pad
const borders = (r: Rect): Segment[] => {
  const corners = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }]
  return corners.map((start, i) => ({ start, end: corners[(i + 1) % 4] }))
}
const first = (e: ContextEdge) => e.path[0]
const last = (e: ContextEdge) => e.path[e.path.length - 1]
const actorPortOf = (e: ContextEdge) => (e.flow === "in" ? first(e) : last(e))
const systemPortOf = (e: ContextEdge) => (e.flow === "in" ? last(e) : first(e))
const width = (l: ContextLayout) => l.bounds.maxX - l.bounds.minX
const height = (l: ContextLayout) => l.bounds.maxY - l.bounds.minY

const fixtureLike = (): ContextActor[] => [
  actor("A01", "human", 2, 2),
  actor("A02", "human", 1, 1),
  actor("A03", "human", 1, 1),
  actor("A04", "human", 1, 1),
  actor("A05", "system", 1, 1),
  actor("A06", "system", 1, 1),
  actor("A07", "system", 1, 1),
  actor("A08", "system", 0, 1),
  actor("A09", "time", 1, 0)
]
const kinds: ActorKind[] = ["human", "system", "time"]
const CASES: { name: string; actors: () => ContextActor[] }[] = [
  { name: "fixture-like ring", actors: fixtureLike },
  { name: "one dense actor (3 in + 3 out)", actors: () => [actor("A01", "human", 3, 3)] },
  { name: "only humans", actors: () => Array.from({ length: 6 }, (_, i) => actor(`H${i}`, "human", 1, 1)) },
  { name: "only systems", actors: () => Array.from({ length: 4 }, (_, i) => actor(`S${i}`, "system", 1, 1)) },
  { name: "only time actors", actors: () => Array.from({ length: 3 }, (_, i) => actor(`T${i}`, "time", 1, 0)) },
  {
    name: "14 mixed actors with long names and labels",
    actors: () => Array.from({ length: 14 }, (_, i) => actor(`M${String(i).padStart(2, "0")}`, kinds[i % 3], 1 + (i % 2), i % 3 === 2 ? 0 : 1, { long: true }))
  },
  { name: "20 humans + 1 system", actors: () => [...Array.from({ length: 20 }, (_, i) => actor(`H${String(i).padStart(2, "0")}`, "human", 1, 1)), actor("S01", "system", 1, 1)] },
  { name: "time actor with 3 in + 3 out", actors: () => [actor("A01", "human", 1, 1), actor("A02", "system", 1, 1), actor("T01", "time", 3, 3)] },
  { name: "only unlabelled arrows", actors: () => [actor("A01", "human", 1, 0, { unlabelled: true }), actor("A02", "system", 0, 1, { unlabelled: true }), actor("A03", "time", 1, 0, { unlabelled: true })] }
]

describe("context layout geometry", () => {
  it.each(CASES)("$name: ports, curves, boxes and labels stay apart", ({ actors: make }) => {
    const actors = make()
    const before = structuredClone(actors)
    const layout = buildContextLayout(actors)
    const r = layout.radiusX
    expect(layout.radiusX).toBe(layout.radiusY)
    expect(actors).toEqual(before)
    expect(layout.actors.map((a) => a.id)).toEqual(actors.map((a) => a.id))
    expect(layout.edges).toHaveLength(actors.reduce((n, a) => n + a.inbound.length + a.outbound.length, 0))

    const paths = layout.edges.map(curveSegments)
    const boxes = new Map(layout.actors.map((a) => [a.id, boxOf(a)]))
    const systemPorts: Point[] = []
    const actorPorts = new Set<string>()
    for (const [k, e] of layout.edges.entries()) {
      const a = layout.actors.find((x) => x.id === e.actorId)!
      const source = actors.find((x) => x.id === e.actorId)!
      expect(e.text).toBe((e.flow === "in" ? source.inbound : source.outbound)[e.index])
      // Không chữ S: trong từng đoạn, hai điểm điều khiển cùng một phía dây cung
      expect((e.path.length - 1) % 3, "đường đi phải là chuỗi Bézier bậc ba").toBe(0)
      for (const [p0, c1, c2, p3] of cubics(e)) {
        expect(cross(p0, p3, c1) * cross(p0, p3, c2), `${e.actorId} ${e.flow}${e.index} uốn chữ S`).toBeGreaterThanOrEqual(-1e-9)
      }
      // Cổng hệ thống nằm đúng trên vòng tròn
      const sys = systemPortOf(e)
      expect(Math.hypot(sys.x, sys.y)).toBeCloseTo(r, 9)
      systemPorts.push(sys)
      // Cổng actor nằm trên mặt hộp quay vào tâm
      const port = actorPortOf(e)
      if (a.sector === "west") expect(port.x).toBeCloseTo(a.center.x + a.width / 2, 9)
      if (a.sector === "east") expect(port.x).toBeCloseTo(a.center.x - a.width / 2, 9)
      if (a.sector === "south") expect(port.y).toBeCloseTo(a.center.y + a.height / 2, 9)
      if (a.sector === "north") expect(port.y).toBeCloseTo(a.center.y - a.height / 2, 9)
      if (a.sector === "west" || a.sector === "east") expect(Math.abs(port.y - a.center.y)).toBeLessThan(a.height / 2)
      else expect(Math.abs(port.x - a.center.x)).toBeLessThan(a.width / 2)
      const key = `${port.x.toFixed(6)},${port.y.toFixed(6)}`
      expect(actorPorts.has(key), `${e.actorId} trùng cổng`).toBe(false)
      actorPorts.add(key)
      // Không đâm vào vòng tròn
      for (const p of curvePoints(e)) expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(r - 1e-7)
      // Không cắt hộp của actor khác, không đi xuyên hộp của chính nó
      for (const [id, box] of boxes) {
        if (id === e.actorId) {
          expect(curvePoints(e).slice(1, -1).some((p) => inside(p, box, 0.5)), `${e.actorId} đi xuyên hộp của chính nó`).toBe(false)
          continue
        }
        expect(paths[k].some((s) => borders(box).some((b) => intersects(s, b))), `${e.actorId} cắt hộp ${id}`).toBe(false)
      }
      // Nhãn: nằm trên chính đường của nó, không đè đường / hộp / vòng tròn / nhãn khác
      const rect = labelRect(e)
      expect(rect === null, `${e.actorId} nhãn null ⇔ không chữ`).toBe(e.text === "")
      if (rect && e.labelPoint) {
        const nearest = Math.min(...paths[k].map((s) => distanceToSegment(e.labelPoint!, s)))
        expect(nearest, `${e.actorId} nhãn rời đường`).toBeLessThanOrEqual(1)
        for (const [j, other] of layout.edges.entries()) {
          if (j === k) continue
          expect(curvePoints(other).some((p) => inside(p, rect, 0.5)), `nhãn ${e.actorId}${e.flow}${e.index} đè đường ${other.actorId}${other.flow}${other.index}`).toBe(false)
          const otherRect = labelRect(other)
          if (otherRect) expect(overlap(rect, otherRect), `nhãn ${e.actorId} đè nhãn ${other.actorId}`).toBe(false)
        }
        for (const box of boxes.values()) expect(overlap(rect, box), `nhãn ${e.actorId} đè hộp`).toBe(false)
        const nearestToCenter = Math.hypot(Math.max(rect.x0, Math.min(0, rect.x1)), Math.max(rect.y0, Math.min(0, rect.y1)))
        expect(nearestToCenter, `nhãn ${e.actorId} đè vòng tròn`).toBeGreaterThan(r)
      }
    }
    // Hai đường bất kỳ không cắt nhau
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
      expect(paths[i].some((a) => paths[j].some((b) => intersects(a, b))), `đường ${i} và ${j} cắt nhau`).toBe(false)
    }
    // Cổng hệ thống không trùng nhau
    for (let i = 0; i < systemPorts.length; i++) for (let j = i + 1; j < systemPorts.length; j++) {
      expect(Math.hypot(systemPorts[i].x - systemPorts[j].x, systemPorts[i].y - systemPorts[j].y), "cổng hệ thống trùng").toBeGreaterThan(3)
    }
    // Hộp không chồng nhau, không đè vòng tròn
    const list = [...boxes.values()]
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) expect(overlap(list[i], list[j]), "hai hộp chồng nhau").toBe(false)
      const nearest = Math.hypot(Math.max(list[i].x0, Math.min(0, list[i].x1)), Math.max(list[i].y0, Math.min(0, list[i].y1)))
      expect(nearest).toBeGreaterThan(r)
    }
    // Tất định
    expect(buildContextLayout(make())).toEqual(layout)
  })

  it("cung theo vai trò: người dùng trái, hệ thống phải, bộ hẹn giờ dưới", () => {
    const layout = buildContextLayout(fixtureLike())
    const at = (id: string) => layout.actors.find((a) => a.id === id)!
    for (const id of ["A01", "A02", "A03", "A04"]) expect(at(id).sector).toBe("west")
    for (const id of ["A05", "A06", "A07", "A08"]) expect(at(id).sector).toBe("east")
    expect(at("A09").sector).toBe("south")
    expect(at("A01").center.x).toBeLessThan(0)
    expect(at("A05").center.x).toBeGreaterThan(0)
    expect(at("A09").center.y).toBeLessThan(-layout.radiusY)
  })

  it("một vai trò duy nhất thì chia đôi sang hai cột", () => {
    const humans = buildContextLayout(Array.from({ length: 5 }, (_, i) => actor(`H${i}`, "human", 1, 1)))
    expect(humans.actors.map((a) => a.sector)).toEqual(["west", "west", "west", "east", "east"])
    const times = buildContextLayout(Array.from({ length: 3 }, (_, i) => actor(`T${i}`, "time", 1, 0)))
    expect(times.actors.map((a) => a.sector)).toEqual(["west", "west", "east"])
  })

  it("actor quá rộng cho hàng dưới thì sang cột", () => {
    const layout = buildContextLayout([actor("A01", "human", 1, 1), actor("A02", "system", 1, 1), actor("T01", "time", 3, 3, { long: true })])
    expect(["west", "east"]).toContain(layout.actors.find((a) => a.id === "T01")!.sector)
  })

  it("một chiều: chỉ có mũi tên của chiều đó", () => {
    const layout = buildContextLayout([actor("A01", "human", 2, 0), actor("A02", "system", 0, 2)])
    expect(layout.edges.filter((e) => e.actorId === "A01").map((e) => e.flow)).toEqual(["in", "in"])
    expect(layout.edges.filter((e) => e.actorId === "A02").map((e) => e.flow)).toEqual(["out", "out"])
  })

  it("khung gọn: không bè quá 1.6 lần chiều cao với sơ đồ nhiều actor", () => {
    for (const make of [fixtureLike, CASES[5].actors]) {
      const layout = buildContextLayout(make())
      const ratio = width(layout) / height(layout)
      expect(ratio).toBeGreaterThanOrEqual(0.9)
      expect(ratio).toBeLessThanOrEqual(1.6 + 0.05)
    }
  })

  it("nan đều trong từng cung", () => {
    const layout = buildContextLayout(fixtureLike())
    const spokes = (sector: string) => layout.actors.filter((a) => a.sector === sector).map((a) => {
      const inner =
        a.sector === "west" ? { x: a.center.x + a.width / 2, y: a.center.y }
        : a.sector === "east" ? { x: a.center.x - a.width / 2, y: a.center.y }
        : a.sector === "south" ? { x: a.center.x, y: a.center.y + a.height / 2 }
        : { x: a.center.x, y: a.center.y - a.height / 2 }
      return Math.hypot(inner.x, inner.y) - layout.radiusX
    })
    // Nan cột trái/phải phải chứa bề rộng nhãn nên dài hơn nan hàng dưới; so sánh trong cùng một cung
    for (const sector of ["west", "east"]) {
      const s = spokes(sector)
      expect(Math.max(...s) / Math.min(...s), sector).toBeLessThanOrEqual(1.6)
    }
  })

  it("gói dòng giữ nguyên nhãn, kể cả từ dài", () => {
    const text = "Export the complete SRS document with Supercalifragilisticexpialidocious metadata"
    const lines = contextLabelLines(text)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(" ")).toBe(text)
    expect(lines).toContain("Supercalifragilisticexpialidocious")
  })

  it("hệ thống giữ gọn (bán kính 100) với sơ đồ nhỏ", () => {
    for (const long of [false, true]) {
      const layout = buildContextLayout([actor("A01", "human", 2, 2, { long }), actor("A02", "system", 1, 1, { long }), actor("A03", "time", 1, 0, { long })])
      expect(layout.radiusX).toBe(100)
      expect(layout.radiusY).toBe(100)
    }
  })

  it("sơ đồ rỗng: chỉ có vòng tròn, khung hữu hạn", () => {
    const layout = buildContextLayout([])
    expect(layout.radiusX).toBeGreaterThan(0)
    expect(layout.actors).toEqual([])
    expect(layout.edges).toEqual([])
    expect(layout.bounds).toEqual({ minX: -layout.radiusX, minY: -layout.radiusY, maxX: layout.radiusX, maxY: layout.radiusY })
  })
})
