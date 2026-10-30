import { describe, expect, it } from "vitest"
import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { ERD_NOTATIONS, type ErdNotation } from "../../../shared/diagram/erd-notation.js"
import type { Scene, SceneElement } from "../../../shared/diagram/svg-scene.js"
import { createEmptySpine } from "../../spine/spine.repository.js"
import type { Entity, Spine } from "../../spine/spine.types.js"
import { DIAGRAM_LABELS } from "./labels.js"
import { layoutErd, type ErdDiagram, type ErdRelationInput } from "./erd-layout.js"
import { MAX_ENTITIES_PER_DIAGRAM, partitionErd, renderErd } from "./erd.renderer.js"

const entity = (id: string, name: string, rel: Record<string, { verb?: string; card?: "1" | "N"; optional?: boolean }> = {}): Entity => ({
  id,
  name,
  description: "",
  relations: Object.keys(rel),
  relation_verbs: Object.fromEntries(Object.entries(rel).flatMap(([t, r]) => (r.verb ? [[t, r.verb]] : []))),
  relation_cardinality: Object.fromEntries(Object.entries(rel).flatMap(([t, r]) => (r.card ? [[t, r.card]] : []))),
  relation_optional: Object.entries(rel).filter(([, r]) => r.optional).map(([t]) => t)
})

const spineOf = (entities: Entity[]): Spine => ({ ...createEmptySpine({ name: "T" }), entities })

const rel = (id: string, from: string, to: string, extra: Partial<ErdRelationInput> = {}): ErdRelationInput => ({ id, from, to, verb: "has", cardinality: "N", optional: false, ...extra })
const diagram = (notation: ErdNotation, entities: ErdDiagram["entities"], relations: ErdRelationInput[]): ErdDiagram => ({ notation, entities, relations, emptyLabel: "No entities yet" })
const scene = (d: ErdDiagram): Scene => {
  const s = layoutErd(d)
  expect(s).not.toBeNull()
  return s!
}
const ids = (s: Scene): string[] => s.elements.map((e) => e.id)
const element = (s: Scene, id: string): SceneElement => {
  const found = s.find(id)
  expect(found, id).toBeDefined()
  return found!
}

const SHOP = spineOf([
  entity("E01", "Customer", { E02: { verb: "places" }, E03: { verb: "writes", optional: true } }),
  entity("E02", "Order", { E04: { verb: "contains", card: "1" } }),
  entity("E03", "Review"),
  entity("E04", "Invoice")
])

describe("erd.renderer — ba ký pháp trên một bộ xếp + đi đường", () => {
  it.each(ERD_NOTATIONS)("%s: SVG, không issue, tô #7ACFF5, tất định", (notation) => {
    const [part] = renderErd(SHOP, null, undefined, { erdNotation: notation })
    expect(part).toMatchObject({ kind: "erd", section: "fixed:3.1.5", format: "svg", owner_id: null })
    expect(part.issues).toEqual([])
    expect(part.source).toContain("#7ACFF5")
    expect(part.source).toContain("<title>Entity Relationship Diagram</title>")
    expect(renderErd(SHOP, null, undefined, { erdNotation: notation })[0].source).toBe(part.source)
  })

  it("mỗi ký pháp ra hình khác nhau; thiếu ký pháp ⇒ chen", () => {
    const sources = ERD_NOTATIONS.map((n) => renderErd(SHOP, null, undefined, { erdNotation: n })[0].source)
    expect(new Set(sources).size).toBe(3)
    expect(renderErd(SHOP)[0].source).toBe(sources[0])
  })

  it("Chen: hình thoi chứa động từ, 1 phía cha / N hoặc 1 phía con, đường đôi khi con bắt buộc có cha", () => {
    const s = scene(diagram("chen", [{ id: "A", name: "Customer" }, { id: "B", name: "Order" }, { id: "C", name: "Review" }], [rel("A>B", "A", "B", { verb: "places" }), rel("A>C", "A", "C", { verb: "writes", optional: true, cardinality: "1" })]))
    expect(element(s, "R:A>B")).toMatchObject({ type: "path", closed: true, role: "shape" })
    const texts = s.elements.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : ""))
    expect(texts).toEqual(expect.arrayContaining(["places", "writes", "1", "N"]))
    // A>B: con (B) tham gia toàn phần ⇒ hai đường song song; A>C tuỳ chọn ⇒ một đường
    expect(ids(s)).toEqual(expect.arrayContaining(["R:A>B:p", "R:A>B:c", "R:A>B:c2", "R:A>C:p", "R:A>C:c"]))
    expect(ids(s)).not.toContain("R:A>C:c2")
    expect(checkScene(s, { allowBends: true })).toEqual([])
  })

  it("Crow's foot: đầu cha `||` / `|o`, đầu con chân chim + vòng (nhiều) hoặc vạch + vòng (một); nhãn động từ trên đường", () => {
    const s = scene(diagram("crowsfoot", [{ id: "A", name: "Customer" }, { id: "B", name: "Order" }, { id: "C", name: "Review" }], [rel("A>B", "A", "B", { verb: "places" }), rel("A>C", "A", "C", { verb: "writes", optional: true, cardinality: "1" })]))
    // A>B: cha đúng một (hai vạch), con không hoặc nhiều (chân chim + vòng)
    expect(ids(s)).toEqual(expect.arrayContaining(["R:A>B#e0-bar-1", "R:A>B#e0-bar-2", "R:A>B#e1-foot-a", "R:A>B#e1-foot-b", "R:A>B#e1-ring"]))
    // A>C: cha không hoặc một (vạch + vòng), con không hoặc một (vạch + vòng)
    expect(ids(s)).toEqual(expect.arrayContaining(["R:A>C#e0-bar-1", "R:A>C#e0-ring", "R:A>C#e1-bar-1", "R:A>C#e1-ring"]))
    expect(ids(s)).not.toContain("R:A>C#e1-foot-a")
    expect(ids(s)).toContain("R:A>B#label")
    expect(element(s, "R:A>B#e1-ring")).toMatchObject({ type: "ellipse", fill: "#fff", role: "decoration" })
    expect(checkScene(s, { allowBends: true })).toEqual([])
  })

  it("IDEF1X: nét đứt (không định danh), chấm đặc ở đầu con, Z khi con tối đa một, thoi rỗng ở đầu cha khi tuỳ chọn", () => {
    const entities = [{ id: "A", name: "Customer" }, { id: "B", name: "Order" }, { id: "C", name: "Review", dependent: true }]
    const s = scene(diagram("idef1x", entities, [rel("A>B", "A", "B"), rel("A>C", "A", "C", { optional: true, cardinality: "1", identifying: true })]))
    expect(element(s, "R:A>B")).toMatchObject({ dashed: true })
    expect(element(s, "R:A>C")).toMatchObject({ dashed: false })
    expect(element(s, "R:A>B#e1-dot")).toMatchObject({ type: "ellipse", fill: "#000", rx: 4.5 })
    expect(element(s, "R:A>C#e0-optional")).toMatchObject({ type: "path", closed: true, fill: "#fff" })
    expect(element(s, "R:A>C#card")).toMatchObject({ type: "text", text: "Z" })
    expect(ids(s)).not.toContain("R:A>B#card")
    // thực thể phụ thuộc bo góc, độc lập vuông góc
    expect(element(s, "C")).toMatchObject({ type: "rect", radius: 10 })
    expect(element(s, "A")).toMatchObject({ type: "rect", radius: 0 })
    expect(checkScene(s, { allowBends: true })).toEqual([])
  })

  it.each(ERD_NOTATIONS)("%s: quan hệ tự thân và nhiều quan hệ giữa hai entity", (notation) => {
    const s = scene(diagram(notation, [{ id: "A", name: "Employee" }, { id: "B", name: "Project" }], [rel("A>A", "A", "A", { verb: "manages" }), rel("A>B", "A", "B", { verb: "leads" }), rel("B>A", "B", "A", { verb: "is staffed by" })]))
    expect(checkScene(s, { allowBends: true })).toEqual([])
    const texts = s.elements.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : ""))
    expect(texts).toEqual(expect.arrayContaining(["manages", "leads", "is staffed by"]))
  })

  it.each(ERD_NOTATIONS)("%s: thuộc tính (khi Spine có) — hộp có ngăn / ô-van, không issue", (notation) => {
    const attributes = [{ name: "id", pk: true }, { name: "customer_id", fk: true }, { name: "created_at" }]
    const s = scene(diagram(notation, [{ id: "A", name: "Customer", attributes }, { id: "B", name: "Order", attributes }], [rel("A>B", "A", "B")]))
    expect(checkScene(s, { allowBends: true })).toEqual([])
    const texts = s.elements.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : ""))
    expect(texts).toEqual(expect.arrayContaining(notation === "crowsfoot" ? ["PK id", "FK customer_id", "created_at"] : notation === "idef1x" ? ["id", "customer_id (FK)", "created_at"] : ["id", "customer_id", "created_at"]))
    if (notation === "chen") expect(s.elements.filter((e) => e.type === "ellipse")).toHaveLength(6)
  })

  it("tên dài gói tối đa 2 dòng; động từ dài gói trong nhãn; không issue", () => {
    const long = "Supplier International Trade Compliance Declaration Record"
    for (const notation of ERD_NOTATIONS) {
      const s = scene(diagram(notation, [{ id: "A", name: long }, { id: "B", name: "Item" }], [rel("A>B", "A", "B", { verb: "is responsible for fulfilling and tracking" })]))
      expect(checkScene(s, { allowBends: true }), notation).toEqual([])
      expect(ids(s).filter((i) => i.startsWith("A#name-")).length).toBeLessThanOrEqual(2)
    }
  })

  it("Spine không entity ⇒ một hộp giữ chỗ; quan hệ tới entity không tồn tại bị bỏ", () => {
    expect(renderErd(spineOf([]))[0].source).toContain(">No entities yet<")
    const dangling = spineOf([entity("E01", "A", { E99: {} })])
    expect(renderErd(dangling)[0].issues).toEqual([])
    expect(renderErd(dangling)[0].source).not.toContain("E99")
  })

  it("động từ thiếu ⇒ has (tiếng Anh) / có (tiếng Việt); Spine không đổi", () => {
    const spine = spineOf([entity("E01", "A", { E02: {} }), entity("E02", "B")])
    const before = structuredClone(spine)
    expect(renderErd(spine, null, undefined, { erdNotation: "crowsfoot" })[0].source).toContain(">has<")
    expect(renderErd(spine, null, DIAGRAM_LABELS.vi, { erdNotation: "crowsfoot" })[0].source).toContain(">có<")
    expect(spine).toEqual(before)
  })

  it(`quá ${MAX_ENTITIES_PER_DIAGRAM} entity ⇒ tách hình, mọi entity có mặt đúng một lần, mỗi hình không issue, tiêu đề (i/n)`, () => {
    const entities = Array.from({ length: 31 }, (_, i) => {
      const id = `E${String(i + 1).padStart(2, "0")}`
      const rel: Record<string, { verb: string }> = {}
      for (const c of [2 * (i + 1), 2 * (i + 1) + 1]) if (c <= 31) rel[`E${String(c).padStart(2, "0")}`] = { verb: "has" }
      return entity(id, `Entity ${i + 1}`, rel)
    })
    for (const notation of ERD_NOTATIONS) {
      const parts = partitionErd(spineOf(entities), notation)
      expect(parts.length, notation).toBeGreaterThanOrEqual(2)
      expect(parts.map((p) => p.title)).toEqual(parts.map((_, i) => `Entity Relationship Diagram (${i + 1}/${parts.length})`))
      const seen = parts.flatMap((p) => p.diagram.entities.map((e) => e.id))
      expect(seen.slice().sort()).toEqual(entities.map((e) => e.id).sort())
      expect(renderErd(spineOf(entities), null, undefined, { erdNotation: notation }).map((p) => p.issues)).toEqual(parts.map(() => []))
    }
  })

  it("thành phần liên thông nhỏ gộp chung một hình khi tổng ≤ giới hạn", () => {
    const pairs = Array.from({ length: 6 }, (_, i) => [entity(`A${i}`, `Parent ${i}`, { [`B${i}`]: {} }), entity(`B${i}`, `Child ${i}`)]).flat()
    expect(partitionErd(spineOf(pairs), "crowsfoot")).toHaveLength(1)
  })
})

/** Mulberry32 — tất định, không phụ thuộc môi trường. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe("erd.renderer — đồ thị ngẫu nhiên (có seed): checkScene luôn rỗng, không mất entity", () => {
  it.each(ERD_NOTATIONS)("%s", (notation) => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = random(seed * 7919)
      const n = 2 + Math.floor(rnd() * 11)
      const idOf = (i: number) => `E${String(i).padStart(2, "0")}`
      const entities = Array.from({ length: n }, (_, i) => {
        const rels: Record<string, { verb: string; card: "1" | "N"; optional: boolean }> = {}
        for (let j = 0; j < n; j++) if (rnd() < 2.2 / n) rels[idOf(j + 1)] = { verb: ["has", "owns", "is assigned to", "contains"][Math.floor(rnd() * 4)], card: rnd() < 0.3 ? "1" : "N", optional: rnd() < 0.3 }
        return entity(idOf(i + 1), `Entity ${i + 1}${rnd() < 0.2 ? " with a rather long descriptive name" : ""}`, rels)
      })
      const parts = renderErd(spineOf(entities), null, undefined, { erdNotation: notation })
      for (const part of parts) expect(part.issues, `${notation} seed ${seed}`).toEqual([])
      const drawn = partitionErd(spineOf(entities), notation).flatMap((p) => p.diagram.entities.map((e) => e.id))
      expect(drawn.sort(), `${notation} seed ${seed}`).toEqual(entities.map((e) => e.id))
    }
  })
})
