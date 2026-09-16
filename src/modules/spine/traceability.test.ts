import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import { buildTraceLinks, trace } from "./traceability.service.js"
import type { Spine } from "./spine.types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const load = (file: string): Spine =>
  spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures", file), "utf8"))) as Spine

const FIXTURE = load("spine-fixture-19-screens.json")

const kinds = (graph: { nodes: { kind: string }[] }): string[] => [...new Set(graph.nodes.map((n) => n.kind))].sort()

describe("trace — bản đồ quanh một thực thể", () => {
  it("actor: ra use case đã trỏ tới nó, rồi function của use case đó", () => {
    const graph = trace(FIXTURE, { entity: "actor", id: "A01" })

    expect(graph.nodes[0]).toEqual({ kind: "actor", id: "A01", label: "Founder" })
    expect(graph.nodes.some((n) => n.kind === "use_case" && n.id === "UC02")).toBe(true)
    expect(graph.edges.some((e) => e.from === "UC02" && e.to === "A01" && e.field === "actor_ids")).toBe(true)
    // Bước 2: function của use case
    expect(graph.nodes.some((n) => n.kind === "function")).toBe(true)
  })

  it("actor nối tới screen qua cầu roles + permissions (không có node role/permission)", () => {
    const graph = trace(FIXTURE, { entity: "actor", id: "A01" }, { depth: 1 })

    expect(kinds(graph)).not.toContain("role")
    expect(graph.edges.some((e) => e.from === "A01" && e.field === "permissions")).toBe(true)
    const screenEdge = graph.edges.find((e) => e.from === "A01" && e.field === "permissions")!
    expect(graph.nodes.some((n) => n.kind === "screen" && n.id === screenEdge.to)).toBe(true)
  })

  it("screen: feature, function và màn kế tiếp trong flow", () => {
    const graph = trace(FIXTURE, { entity: "screen", id: "S01" }, { depth: 1 })

    expect(graph.edges.some((e) => e.from === "S01" && e.to === "F1" && e.field === "feature_id")).toBe(true)
    expect(graph.edges.some((e) => e.from === "S01" && e.to === "S02" && e.field === "flow_to")).toBe(true)
    expect(graph.edges.some((e) => e.from === "FN001" && e.to === "S01" && e.field === "screen_id")).toBe(true)
  })

  it("entity: chỉ quan hệ entity ↔ entity", () => {
    const graph = trace(FIXTURE, { entity: "entity", id: FIXTURE.entities[0].id }, { depth: 1 })
    expect(kinds(graph)).toEqual(["entity"])
  })

  it("thực thể không tồn tại ⇒ đồ thị rỗng, không ném", () => {
    expect(trace(FIXTURE, { entity: "actor", id: "KHONG-CO" })).toEqual({ nodes: [], edges: [] })
  })

  it("read-only: không đụng Spine", () => {
    const before = JSON.stringify(FIXTURE)
    trace(FIXTURE, { entity: "actor", id: "A01" })
    expect(JSON.stringify(FIXTURE)).toBe(before)
  })

  it("mọi cạnh đều có hai đầu nằm trong nodes", () => {
    const graph = trace(FIXTURE, { entity: "use_case", id: "UC01" })
    const ids = new Set(graph.nodes.map((n) => n.id))
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
  })
})

describe("buildTraceLinks", () => {
  it("business rule nối tới function qua source_validation_ids", () => {
    const withRule = structuredClone(FIXTURE)
    withRule.business_rules.push({
      id: "BR-T17",
      tier: "detail",
      statement: "Email must be unique.",
      source_validation_ids: ["FN001-V1"]
    })

    const links = buildTraceLinks(withRule)
    expect(
      links.some((l) => l.from.kind === "business_rule" && l.from.id === "BR-T17" && l.to.kind === "function" && l.to.id === "FN001")
    ).toBe(true)
  })

  it("không sinh node cho collection ngoài 8 loại (diagrams, addendum, flags)", () => {
    const links = buildTraceLinks(FIXTURE)
    const allKinds = new Set(links.flatMap((l) => [l.from.kind, l.to.kind]))
    for (const kind of allKinds) {
      expect(["actor", "use_case", "function", "screen", "entity", "nfr", "feature", "business_rule"]).toContain(kind)
    }
  })
})
