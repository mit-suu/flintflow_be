import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../../spine/spine.repository.js"
import type { Entity, EntityAttribute, Spine } from "../../spine/spine.types.js"
import { renderedDiagramHash } from "../../spine/source-hash.js"
import { DIAGRAM_LABELS } from "./labels.js"
import { MAX_CLASSES_PER_DIAGRAM, partitionClass, renderClass } from "./class.renderer.js"
import { renderKind } from "./index.js"

const attr = (name: string, kind: EntityAttribute["kind"] = "plain", required = true): EntityAttribute => ({ name, kind, required })

const entity = (
  id: string,
  name: string,
  featureIds: string[],
  rel: Record<string, { verb?: string; card?: "1" | "N"; optional?: boolean }> = {},
  attributes: EntityAttribute[] = []
): Entity => ({
  id,
  name,
  description: "",
  relations: Object.keys(rel),
  relation_verbs: Object.fromEntries(Object.entries(rel).flatMap(([t, r]) => (r.verb ? [[t, r.verb]] : []))),
  relation_cardinality: Object.fromEntries(Object.entries(rel).flatMap(([t, r]) => (r.card ? [[t, r.card]] : []))),
  relation_optional: Object.entries(rel).filter(([, r]) => r.optional).map(([t]) => t),
  attributes,
  feature_ids: featureIds
})

const spineOf = (entities: Entity[], features = [{ id: "F1", name: "Ordering", order: 0 }, { id: "F2", name: "Billing", order: 1 }]): Spine => ({
  ...createEmptySpine({ name: "T" }),
  features,
  entities
})

const SHOP = spineOf([
  entity("E01", "Customer", ["F1", "F2"], { E02: { verb: "places" }, E03: { verb: "pays", optional: true } }, [attr("email", "key"), attr("phone", "plain", false)]),
  entity("E02", "Order", ["F1"], { E04: { verb: "contains", card: "1" } }, [attr("order number", "key"), attr("customer", "reference")]),
  entity("E03", "Payment", ["F2"]),
  entity("E04", "Invoice", ["F1", "F2"])
])

describe("class.renderer — mỗi feature một hình, mức domain", () => {
  it("một hình mỗi feature có entity, theo thứ tự feature; chủ = feature, section = feature:<id>", () => {
    const parts = renderClass(SHOP)
    expect(parts.map((p) => [p.kind, p.format, p.owner_kind, p.owner_id, p.section])).toEqual([
      ["class", "svg", "feature", "F1", "feature:F1"],
      ["class", "svg", "feature", "F2", "feature:F2"]
    ])
    for (const p of parts) {
      expect(p.issues, p.owner_id!).toEqual([])
      expect(p.source).toContain("#7ACFF5")
    }
    expect(parts[0].source).toContain("<title>Class Diagram — Ordering</title>")
  })

  it("entity của nhiều feature xuất hiện ở từng hình; quan hệ sang feature khác không vẽ; không thêm class", () => {
    const [f1, f2] = partitionClass(SHOP)
    expect(f1.diagram.nodes.map((n) => n.id)).toEqual(["E01", "E02", "E04"])
    expect(f2.diagram.nodes.map((n) => n.id)).toEqual(["E01", "E03", "E04"])
    expect(f1.diagram.relations.map((r) => r.id)).toEqual(["E01>E02", "E02>E04"])
    // E01 → E03 (Payment) chỉ có ở hình F2; E01 → E02 không có ở F2 vì Order không thuộc F2
    expect(f2.diagram.relations.map((r) => r.id)).toEqual(["E01>E03"])
  })

  it("bản số suy từ cardinality + optional; tên quan hệ = relation_verbs; thiếu động từ ⇒ has", () => {
    const [f1, f2] = partitionClass(SHOP)
    expect(f1.diagram.relations).toEqual([
      { id: "E01>E02", from: "E01", to: "E02", kind: "association", name: "places", fromMultiplicity: "1", toMultiplicity: "*" },
      { id: "E02>E04", from: "E02", to: "E04", kind: "association", name: "contains", fromMultiplicity: "1", toMultiplicity: "0..1" }
    ])
    expect(f2.diagram.relations[0]).toMatchObject({ name: "pays", fromMultiplicity: "0..1", toMultiplicity: "*" })
    const noVerb = spineOf([entity("E01", "A", ["F1"], { E02: {} }), entity("E02", "B", ["F1"])])
    expect(partitionClass(noVerb)[0].diagram.relations[0].name).toBe("has")
    expect(partitionClass(noVerb, DIAGRAM_LABELS.vi)[0].diagram.relations[0].name).toBe("có")
  })

  it("thuộc tính chỉ in tên + {id} / {ref} / [0..1]; không kiểu dữ liệu, không ngăn thao tác, không stereotype", () => {
    const [part] = renderClass(SHOP)
    for (const text of ["email {id}", "phone [0..1]", "order number {id}", "customer {ref}"]) expect(part.source, text).toContain(`>${text}<`)
    expect(part.source).not.toContain("&lt;&lt;")
    expect(part.source).not.toMatch(/\(\)|: string/)
  })

  it("không có feature_ids / feature không tồn tại ⇒ không có hình (Spine cũ, import mode 1); không placeholder", () => {
    expect(renderClass(spineOf([entity("E01", "A", []), entity("E02", "B", ["F9"])]))).toEqual([])
    expect(renderClass(spineOf([]))).toEqual([])
    const legacy = spineOf([{ ...entity("E01", "A", []), attributes: undefined, feature_ids: undefined }])
    expect(renderClass(legacy)).toEqual([])
  })

  it("class không thuộc tính chỉ có ngăn tên", () => {
    const [part] = renderClass(spineOf([entity("E01", "Lonely", ["F1"])]))
    expect(part.source).toContain(">Lonely<")
    expect(part.source).not.toContain("<line")
    expect(part.issues).toEqual([])
  })

  it("quan hệ tự thân và hai quan hệ giữa một cặp: qua checkScene", () => {
    const spine = spineOf([
      entity("E01", "Comment", ["F1"], { E01: { verb: "replies to" }, E02: { verb: "has" } }, [attr("body")]),
      entity("E02", "Reaction", ["F1"], { E01: { verb: "marks" } })
    ])
    const [part] = renderClass(spine)
    expect(part.issues).toEqual([])
    expect(part.source).toContain("replies to")
  })

  it(`quá ${MAX_CLASSES_PER_DIAGRAM} class trong một feature ⇒ tách, tiêu đề (i/n), mỗi hình ≤ ${MAX_CLASSES_PER_DIAGRAM} class, cùng chủ`, () => {
    const key = (i: number): string => `E${String(i).padStart(2, "0")}`
    const many = Array.from({ length: 30 }, (_, i) => entity(key(i + 1), `Item ${i + 1}`, ["F1"], i % 3 === 0 && i + 1 < 30 ? { [key(i + 2)]: {} } : {}))
    const parts = renderClass(spineOf(many))
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.owner_id === "F1" && p.section === "feature:F1" && (p.issues ?? []).length === 0)).toBe(true)
    expect(parts[0].source).toContain(`<title>Class Diagram — Ordering (1/${parts.length})</title>`)
    const sizes = partitionClass(spineOf(many)).map((p) => p.diagram.nodes.length)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_CLASSES_PER_DIAGRAM)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(30)
  })

  it("tên dài và nhiều thuộc tính: qua checkScene, chữ dài cắt bằng ...", () => {
    const long = Array.from({ length: 14 }, (_, i) => attr(`attribute ${i + 1} with an extremely long descriptive label that cannot possibly fit in a class box`, "plain", i % 2 === 0))
    const spine = spineOf([entity("E01", "A Very Long Entity Name For The Whole Customer Order Fulfilment Process", ["F1"], { E02: { verb: "contains" } }, long), entity("E02", "Line", ["F1"])])
    const [part] = renderClass(spine)
    expect(part.issues).toEqual([])
    expect(part.source).toContain("...")
  })

  it("tất định; renderKind ghi source_hash theo từng chủ", () => {
    expect(renderClass(SHOP).map((p) => p.source)).toEqual(renderClass(SHOP).map((p) => p.source))
    const parts = renderKind(SHOP, "class")
    expect(parts.map((p) => p.source_hash)).toEqual(parts.map((p) => renderedDiagramHash(SHOP, { kind: "class", owner_id: p.owner_id })))
    expect(new Set(parts.map((p) => p.source_hash)).size).toBe(2)
  })

  it("hình tiếng Việt: tiêu đề theo ngôn ngữ", () => {
    const spine = spineOf([entity("E01", "A", ["F1"], { E02: {} }), entity("E02", "B", ["F1"])])
    const [part] = renderClass(spine, null, DIAGRAM_LABELS.vi)
    expect(part.source).toContain("<title>Sơ đồ lớp — Ordering</title>")
  })
})
