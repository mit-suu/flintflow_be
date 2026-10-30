import { describe, expect, it } from "vitest"
import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { layoutScreenFlow, planFlow, type FlowDiagram } from "./screen-flow-layout.js"

describe("planFlow", () => {
  const plan = (ids: string[], flows: [string, string][], popups: string[] = []) => planFlow(ids, new Set(popups), flows)

  it("màn vào = đại diện của thành phần không có cạnh tới từ ngoài; cặp trỏ qua lại giữ chiều đi tiếp", () => {
    const p = plan(["A", "B", "C", "D"], [["A", "B"], ["B", "A"], ["B", "C"]])
    expect(p.entries).toEqual(["A", "D"])
    expect(p.edges).toEqual([["A", "B"], ["B", "C"]])
    expect(p.sinks).toEqual(["C", "D"])
    expect([...p.rank]).toEqual([["A", 0], ["B", 1], ["C", 2], ["D", 0]])
  })

  it("hạng = đường dài nhất, cạnh luôn đi xuống; vòng dài không vẽ cạnh quay lại; bỏ cạnh ngoài / tự trỏ / trùng", () => {
    const p = plan(["A", "B", "C"], [["A", "B"], ["B", "C"], ["A", "C"], ["C", "A"], ["A", "A"], ["A", "B"], ["A", "Z"]])
    expect(p.edges).toEqual([["A", "B"], ["A", "C"], ["B", "C"]])
    expect(p.rank.get("C")).toBe(2)
    for (const [from, to] of p.edges) expect(p.rank.get(to)!).toBeGreaterThan(p.rank.get(from)!)
  })

  it("thành phần liên thông mạnh: đại diện không phải pop-up khi có màn khác", () => {
    expect(plan(["P", "Q"], [["P", "Q"], ["Q", "P"]], ["P"]).entries).toEqual(["Q"])
  })
})

const diagram = (over: Partial<FlowDiagram> = {}): FlowDiagram => ({
  lanes: [{ id: "A", name: "Actor A" }, { id: "B", name: "Actor B" }],
  nodes: [
    { id: "S1", name: "First", lane: 0, popup: false, tabs: [] },
    { id: "S2", name: "Second", lane: 1, popup: false, tabs: [] },
    { id: "S3", name: "Third", lane: 0, popup: true, tabs: [] }
  ],
  edges: [["S1", "S2"], ["S2", "S3"], ["S1", "S3"]],
  popupLabel: "pop-up",
  ...over
})

describe("layoutScreenFlow", () => {
  it("initial = chấm đặc, final = vòng + chấm, action bo góc, đường mũi tên hở nét liền", () => {
    const scene = layoutScreenFlow(diagram())
    const svg = scene.toSvg()
    expect(scene.find("initial:S1")).toMatchObject({ type: "ellipse", fill: "#000" })
    expect(scene.find("final:S3")).toMatchObject({ type: "ellipse", fill: "#fff" })
    expect(scene.find("final:S3#core")).toMatchObject({ type: "ellipse", fill: "#000" })
    expect(scene.find("S1")).toMatchObject({ type: "rect", radius: 10, fill: "#7ACFF5" })
    expect(svg).not.toContain("stroke-dasharray")
    expect(scene.find("flow:S1>S2#end")).toMatchObject({ closed: false })
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  it("làn là container, tên làn ở đầu làn", () => {
    const scene = layoutScreenFlow(diagram())
    expect(scene.find("lane:A")).toMatchObject({ container: true, y: 0 })
    expect(scene.find("lane:A#t0")).toMatchObject({ text: "Actor A", bold: true })
  })

  it("không có tên làn ⇒ không vẽ khung làn", () => {
    const scene = layoutScreenFlow(diagram({ lanes: [], nodes: diagram().nodes.map((n) => ({ ...n, lane: 0 })) }))
    expect(scene.elements.some((e) => e.id.startsWith("lane:"))).toBe(false)
  })

  it("không đường nào xuyên hình, đè chữ hay chồng nhau; mọi đoạn song song trục (ngẫu nhiên, có seed)", () => {
    let seed = 7
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
    for (let t = 0; t < 150; t++) {
      const n = 1 + Math.floor(rnd() * 25)
      const lanes = 1 + Math.floor(rnd() * 5)
      const nodes = Array.from({ length: n }, (_, i) => ({
        id: `S${i}`,
        name: `Screen ${i} ${"word ".repeat(Math.floor(rnd() * 12))}`,
        lane: Math.floor(rnd() * lanes),
        popup: rnd() < 0.15,
        tabs: rnd() < 0.15 ? ["Chat", "Document", "History"] : []
      }))
      const edges = Array.from({ length: Math.floor(rnd() * n * 2.2) }, (): [string, string] => [`S${Math.floor(rnd() * n)}`, `S${Math.floor(rnd() * n)}`])
      const scene = layoutScreenFlow({ lanes: Array.from({ length: lanes }, (_, i) => ({ id: `A${i}`, name: `Actor ${i}` })), nodes, edges, popupLabel: "pop-up" })
      expect(checkScene(scene, { allowBends: true }), `case ${t}`).toEqual([])
    }
  })
})
