import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../../spine/spine.repository.js"
import { renderContext } from "./context.renderer.js"
import {
  buildContextLayout,
  contextLabelLines,
  type ActorKind,
  type Box,
  type ContextActor,
  type ContextEdge,
  type Point
} from "./context-layout.js"

type Options = { long?: boolean }
const actor = (id: string, kind: ActorKind, nIn: number, nOut: number, { long = false }: Options = {}): ContextActor => {
  const text = (word: string, i: number) => (long ? `${word} ${i} with all the details required to update the requirements` : `${word} ${id} ${i}`)
  return {
    id,
    kind,
    name: long ? `External actor ${id} with a long descriptive name` : `Actor ${id}`,
    inbound: Array.from({ length: nIn }, (_, i) => text("Input", i)),
    outbound: Array.from({ length: nOut }, (_, i) => text("Output", i))
  }
}

const EPS = 1e-6
const orient = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
/** Hai đoạn cắt nhau thật sự (kể cả chạm giữa đoạn). */
const crosses = (a: ContextEdge, b: ContextEdge): boolean =>
  orient(a.from, a.to, b.from) * orient(a.from, a.to, b.to) < -EPS && orient(b.from, b.to, a.from) * orient(b.from, b.to, a.to) < -EPS
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const onBoxBorder = (p: Point, b: Box): boolean => {
  const insideX = p[0] >= b.x - 1e-4 && p[0] <= b.x + b.w + 1e-4
  const insideY = p[1] >= b.y - 1e-4 && p[1] <= b.y + b.h + 1e-4
  const onX = Math.abs(p[0] - b.x) < 1e-4 || Math.abs(p[0] - (b.x + b.w)) < 1e-4
  const onY = Math.abs(p[1] - b.y) < 1e-4 || Math.abs(p[1] - (b.y + b.h)) < 1e-4
  return insideX && insideY && (onX || onY)
}

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
const CASES: { name: string; actors: () => ContextActor[]; system?: string }[] = [
  { name: "fixture-like ring", actors: fixtureLike },
  { name: "one actor", actors: () => [actor("A01", "human", 1, 1)] },
  { name: "one dense actor (6 in + 6 out)", actors: () => [actor("A01", "human", 6, 6)] },
  { name: "only humans", actors: () => Array.from({ length: 6 }, (_, i) => actor(`H${i}`, "human", 1, 1)) },
  { name: "only systems", actors: () => Array.from({ length: 4 }, (_, i) => actor(`S${i}`, "system", 1, 1)) },
  { name: "only time actors", actors: () => Array.from({ length: 3 }, (_, i) => actor(`T${i}`, "time", 1, 0)) },
  { name: "9 actors x 6 flows", actors: () => Array.from({ length: 9 }, (_, i) => actor(`M${i}`, kinds[i % 3], 3, 3)) },
  {
    name: "14 mixed actors with long names and 60-char labels",
    actors: () => Array.from({ length: 14 }, (_, i) => actor(`M${String(i).padStart(2, "0")}`, kinds[i % 3], 1 + (i % 2), i % 3 === 2 ? 0 : 1, { long: true }))
  },
  { name: "20 humans + 1 system", actors: () => [...Array.from({ length: 20 }, (_, i) => actor(`H${String(i).padStart(2, "0")}`, "human", 1, 1)), actor("S01", "system", 1, 1)] },
  { name: "long system name", actors: fixtureLike, system: "An Extremely Long System Name For The Whole Platform" },
  { name: "empty", actors: () => [] }
]

const spineOf = (actors: ContextActor[], name: string) => {
  const spine = createEmptySpine({ name })
  spine.actors = actors.map((a) => ({ id: a.id, name: a.name, kind: a.kind, description: "", flows_in: [...a.inbound], flows_out: [...a.outbound] }))
  return spine
}

describe("context layout geometry", () => {
  it.each(CASES)("$name: một đoạn thẳng mỗi luồng, không cắt nhau, không chồng hộp, không lỗi bố cục", ({ actors: make, system }) => {
    const actors = make()
    const before = structuredClone(actors)
    const layout = buildContextLayout(actors, system)
    const { cx, cy, r } = layout.circle
    expect(actors).toEqual(before)
    expect(layout.actors.map((a) => a.id)).toEqual(actors.map((a) => a.id))
    expect(layout.edges).toHaveLength(actors.reduce((n, a) => n + a.inbound.length + a.outbound.length, 0))

    for (const e of layout.edges) {
      const a = layout.actors.find((x) => x.id === e.actorId)!
      const source = actors.find((x) => x.id === e.actorId)!
      expect(e.text).toBe((e.flow === "in" ? source.inbound : source.outbound)[e.index])
      // Đầu tại viền vòng tròn, đuôi tại viền hộp (in: hộp → tròn; out: tròn → hộp)
      const [boxEnd, circleEnd] = e.flow === "in" ? [e.from, e.to] : [e.to, e.from]
      expect(Math.hypot(circleEnd[0] - cx, circleEnd[1] - cy), `${e.actorId} ${e.flow}${e.index} đầu trên vòng tròn`).toBeCloseTo(r, 6)
      expect(onBoxBorder(boxEnd, a.box), `${e.actorId} ${e.flow}${e.index} đầu trên viền hộp`).toBe(true)
    }
    // Hai đường bất kỳ không cắt nhau — kể cả khác actor
    for (let i = 0; i < layout.edges.length; i++) {
      for (let j = i + 1; j < layout.edges.length; j++) expect(crosses(layout.edges[i], layout.edges[j]), `đường ${i} và ${j} cắt nhau`).toBe(false)
    }
    // Hộp không chồng hộp, không chồng vòng tròn
    for (let i = 0; i < layout.actors.length; i++) {
      const a = layout.actors[i].box
      for (const b of layout.actors.slice(i + 1)) expect(overlap(a, b.box), `${layout.actors[i].id} chồng ${b.id}`).toBe(false)
      const near = Math.hypot(Math.max(a.x, Math.min(cx, a.x + a.w)) - cx, Math.max(a.y, Math.min(cy, a.y + a.h)) - cy)
      expect(near).toBeGreaterThan(r)
    }
    // Tất định
    expect(buildContextLayout(make(), system)).toEqual(layout)
    // Bộ kiểm hình học của Scene (chữ đè chữ / hình, đường xuyên hình, chồng đường…) sạch
    const [part] = renderContext(spineOf(actors, system ?? "System"))
    expect(part.issues, JSON.stringify(part.issues)).toEqual([])
  })

  it("người dùng nửa trái, hệ thống ngoài + bộ hẹn giờ nửa phải", () => {
    const layout = buildContextLayout(fixtureLike())
    const at = (id: string) => layout.actors.find((a) => a.id === id)!
    for (const id of ["A01", "A02", "A03", "A04"]) expect(at(id).side).toBe("left")
    for (const id of ["A05", "A06", "A07", "A08", "A09"]) expect(at(id).side).toBe("right")
    expect(at("A01").box.x + at("A01").box.w).toBeLessThan(layout.circle.cx)
    expect(at("A09").box.x).toBeGreaterThan(layout.circle.cx)
  })

  it("một vai trò duy nhất thì chia đôi sang hai nửa, giữ thứ tự id", () => {
    const humans = buildContextLayout(Array.from({ length: 5 }, (_, i) => actor(`H${i}`, "human", 1, 1)))
    expect(humans.actors.map((a) => a.side)).toEqual(["left", "left", "left", "right", "right"])
    const times = buildContextLayout(Array.from({ length: 3 }, (_, i) => actor(`T${i}`, "time", 1, 0)))
    expect(times.actors.map((a) => a.side)).toEqual(["left", "left", "right"])
  })

  it("các luồng của một actor song song nhau, cách nhau đều", () => {
    const layout = buildContextLayout([actor("A01", "human", 3, 2), actor("A02", "system", 1, 1)])
    const mine = layout.edges.filter((e) => e.actorId === "A01")
    expect(mine).toHaveLength(5)
    const dir = (e: ContextEdge): Point => {
      const [a, b] = e.flow === "in" ? [e.from, e.to] : [e.to, e.from]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      return [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
    }
    const d0 = dir(mine[0])
    for (const e of mine) {
      const d = dir(e)
      expect(Math.abs(d[0] * d0[1] - d[1] * d0[0])).toBeLessThan(1e-6)
    }
  })

  it("mỗi phần tử một mũi tên, không giới hạn (12 luồng một chiều)", () => {
    const layout = buildContextLayout([actor("A01", "human", 12, 0), actor("A02", "system", 0, 1)])
    expect(layout.edges.filter((e) => e.actorId === "A01")).toHaveLength(12)
  })

  it("hệ thống giữ gọn với sơ đồ nhỏ, vòng tròn ở gốc", () => {
    const layout = buildContextLayout([actor("A01", "human", 1, 1), actor("A02", "system", 1, 1)])
    expect(layout.circle).toMatchObject({ cx: 0, cy: 0, r: 110 })
  })

  it("gói dòng giữ nguyên nhãn, kể cả từ dài", () => {
    const text = "Export the complete SRS document with Supercalifragilisticexpialidocious metadata"
    const lines = contextLabelLines(text)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(" ")).toBe(text)
    expect(lines).toContain("Supercalifragilisticexpialidocious")
  })

  it("sơ đồ rỗng: chỉ có vòng tròn", () => {
    const layout = buildContextLayout([])
    expect(layout.circle.r).toBeGreaterThan(0)
    expect(layout.actors).toEqual([])
    expect(layout.edges).toEqual([])
  })
})
