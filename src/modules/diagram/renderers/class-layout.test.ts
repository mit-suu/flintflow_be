import { describe, expect, it } from "vitest"
import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import type { Scene, SceneElement } from "../../../shared/diagram/svg-scene.js"
import { attributeText, layoutClass, type ClassDiagram, type ClassRelationInput } from "./class-layout.js"

const node = (id: string, name: string, attributes: ClassDiagram["nodes"][number]["attributes"] = []) => ({ id, name, attributes })
const rel = (from: string, to: string, extra: Partial<ClassRelationInput> = {}): ClassRelationInput => ({
  id: `${from}>${to}`,
  from,
  to,
  kind: "association",
  name: "has",
  fromMultiplicity: "1",
  toMultiplicity: "*",
  ...extra
})
const scene = (d: ClassDiagram): Scene => {
  const s = layoutClass(d)
  expect(s).not.toBeNull()
  expect(checkScene(s!, { allowBends: true })).toEqual([])
  return s!
}
const el = (s: Scene, id: string): SceneElement => {
  const found = s.find(id)
  expect(found, id).toBeDefined()
  return found!
}
const noLabels = { name: "", fromMultiplicity: "", toMultiplicity: "" }

describe("class-layout — hộp class và đầu mút UML", () => {
  it("attributeText: tên, {id}, {ref}, [0..1]", () => {
    expect(attributeText({ name: "email", kind: "key", required: true })).toBe("email {id}")
    expect(attributeText({ name: "owner", kind: "reference", required: false })).toBe("owner {ref} [0..1]")
    expect(attributeText({ name: "  note  ", kind: "plain", required: false })).toBe("note [0..1]")
    expect(attributeText({ name: "x".repeat(200), kind: "plain", required: true })).toMatch(/\.\.\.$/)
  })

  it("hộp hai ngăn: tên đậm giữa, đường chia, thuộc tính căn trái; chỉ tên ⇒ không đường chia", () => {
    const s = scene({ nodes: [node("A", "Order", [{ name: "code", kind: "key", required: true }]), node("B", "Empty")], relations: [] })
    expect(el(s, "A#name-0")).toMatchObject({ type: "text", bold: true, anchor: "middle" })
    expect(el(s, "A#attr-0")).toMatchObject({ type: "text", text: "code {id}", anchor: "start", bold: false })
    expect(el(s, "A#rule-0")).toMatchObject({ role: "decoration" })
    expect(s.find("B#rule-0")).toBeUndefined()
    expect(s.find("A#attr-1")).toBeUndefined()
  })

  it("association: đường liền không mũi tên, bản số hai đầu, tên quan hệ", () => {
    const s = scene({ nodes: [node("A", "Customer"), node("B", "Order")], relations: [rel("A", "B", { name: "places", fromMultiplicity: "1", toMultiplicity: "1..*" })] })
    expect(el(s, "R:A>B")).toMatchObject({ type: "path", role: "connector", dashed: false })
    expect(el(s, "R:A>B#m0")).toMatchObject({ text: "1" })
    expect(el(s, "R:A>B#m1")).toMatchObject({ text: "1..*" })
    expect(el(s, "R:A>B#label")).toMatchObject({ text: "places" })
    expect(s.find("R:A>B#start")).toBeUndefined()
    expect(s.find("R:A>B#end")).toBeUndefined()
  })

  it("aggregation: thoi rỗng ở phía tổng thể (đầu from); composition: thoi đặc", () => {
    const agg = scene({ nodes: [node("A", "Team"), node("B", "Player")], relations: [rel("A", "B", { kind: "aggregation" })] })
    expect(el(agg, "R:A>B#start")).toMatchObject({ closed: true, fill: "#fff" })
    expect((el(agg, "R:A>B#start") as { points: unknown[] }).points).toHaveLength(4)
    expect(agg.find("R:A>B#end")).toBeUndefined()
    const comp = scene({ nodes: [node("A", "Order"), node("B", "Line")], relations: [rel("A", "B", { kind: "composition" })] })
    expect(el(comp, "R:A>B#start")).toMatchObject({ closed: true, fill: "#000" })
  })

  it("generalization: tam giác rỗng ở class cha (đầu to), không bản số, không tên; cha nằm trên con", () => {
    const s = scene({
      nodes: [node("P", "Person"), node("S", "Student"), node("T", "Teacher")],
      relations: [rel("S", "P", { kind: "generalization", ...noLabels }), rel("T", "P", { kind: "generalization", ...noLabels })]
    })
    for (const id of ["R:S>P", "R:T>P"]) {
      const head = el(s, `${id}#end`) as { points: unknown[]; closed: boolean; fill: string }
      expect(head).toMatchObject({ closed: true, fill: "#fff" })
      expect(head.points).toHaveLength(3)
      expect(s.find(`${id}#m0`)).toBeUndefined()
      expect(s.find(`${id}#label`)).toBeUndefined()
    }
    const y = (id: string): number => (el(s, id) as { y: number }).y
    expect(y("P")).toBeLessThan(y("S"))
  })

  it("quan hệ tự thân, hai cạnh giữa một cặp, class rất cao: qua checkScene", () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ name: `attribute ${i + 1}`, kind: "plain" as const, required: true }))
    const s = scene({
      nodes: [node("A", "Customer Order Fulfilment Request Aggregate", many), node("B", "Line", [{ name: "quantity", kind: "plain", required: true }]), node("C", "Invoice")],
      relations: [rel("A", "B", { name: "contains" }), rel("A", "C", { name: "billed" }), rel("A", "A", { name: "supersedes" }), rel("B", "C", { name: "references" }), rel("C", "B", { name: "lists" })]
    })
    expect(s.find("R:A>A")).toBeDefined()
    expect(s.find("R:A>A#label")).toBeDefined()
  })

  it("mọi đường chỉ có đoạn song song trục (gấp khúc vuông góc)", () => {
    const nodes = ["A", "B", "C", "D", "E", "F"].map((id) => node(id, `Class ${id}`, [{ name: "code", kind: "key", required: true }]))
    const s = scene({ nodes, relations: [rel("A", "B"), rel("A", "C"), rel("B", "D"), rel("C", "D"), rel("D", "E"), rel("A", "F"), rel("F", "E")] })
    const lines = s.elements.filter((x) => x.role === "connector")
    expect(lines).toHaveLength(7)
    for (const e of lines) {
      const pts = (e as unknown as { points: [number, number][] }).points
      pts.slice(1).forEach((p, i) => expect(p[0] === pts[i][0] || p[1] === pts[i][1], e.id).toBe(true))
    }
  })

  it("tô #7ACFF5, viền / chữ đen; tất định", () => {
    const d: ClassDiagram = { nodes: [node("A", "Order"), node("B", "Line")], relations: [rel("A", "B", { kind: "composition" })] }
    const svg = scene(d).toSvg("t")
    expect(svg).toContain('fill="#7ACFF5"')
    for (const fill of svg.match(/fill="#[0-9a-fA-F]{3,6}"/g) ?? []) expect(["#7ACFF5", "#000", "#fff"]).toContain(fill.slice(6, -1))
    expect(scene(d).toSvg("t")).toBe(svg)
  })

  it("quan hệ tới id lạ bị bỏ; đồ thị không có quan hệ vẫn xếp được", () => {
    const s = scene({ nodes: [node("A", "Alone")], relations: [rel("A", "ZZ")] })
    expect(s.find("R:A>ZZ")).toBeUndefined()
  })
})
