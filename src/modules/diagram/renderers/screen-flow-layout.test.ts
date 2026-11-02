import { describe, expect, it } from "vitest"
import { checkScene, overlaps } from "../../../shared/diagram/svg-geometry.js"
import type { Point } from "../../../shared/diagram/svg-kit.js"
import { outline, type SceneElement } from "../../../shared/diagram/svg-scene.js"
import { flowColumns, flowTree, layoutScreenFlow, planFlow, type FlowDiagram, type FlowNode } from "./screen-flow-layout.js"

describe("planFlow", () => {
  const plan = (ids: string[], flows: [string, string][], popups: string[] = []) => planFlow(ids, new Set(popups), flows)

  it("màn vào = đại diện của thành phần không có cạnh tới từ ngoài; cặp trỏ qua lại giữ chiều đi tiếp", () => {
    const p = plan(["A", "B", "C", "D"], [["A", "B"], ["B", "A"], ["B", "C"]])
    expect(p.entries).toEqual(["A", "D"])
    expect(p.edges).toEqual([["A", "B"], ["B", "C"]])
    expect(p.sinks).toEqual(["C", "D"])
    expect([...p.rank]).toEqual([["A", 0], ["B", 1], ["C", 2], ["D", 0]])
  })

  it("hạng = đường dài nhất, cạnh luôn tăng hạng; vòng dài không vẽ cạnh quay lại; bỏ cạnh ngoài / tự trỏ / trùng", () => {
    const p = plan(["A", "B", "C"], [["A", "B"], ["B", "C"], ["A", "C"], ["C", "A"], ["A", "A"], ["A", "B"], ["A", "Z"]])
    expect(p.edges).toEqual([["A", "B"], ["A", "C"], ["B", "C"]])
    expect(p.rank.get("C")).toBe(2)
    for (const [from, to] of p.edges) expect(p.rank.get(to)!).toBeGreaterThan(p.rank.get(from)!)
  })

  it("cây bố cục: cha = đường vào nông nhất (hoà thì màn đứng trước), cột = độ sâu; liên kết chéo không đẩy nhánh sang phải", () => {
    // A → B → C → D và A → D: hạng đường dài nhất đặt D ở cột 3, độ sâu đặt D ngay sau A
    const p = plan(["A", "B", "C", "D", "E"], [["A", "B"], ["B", "C"], ["C", "D"], ["A", "D"], ["B", "E"], ["C", "E"]])
    const { parent, depth } = flowTree(p)
    expect([...parent].sort()).toEqual([["B", "A"], ["C", "B"], ["D", "A"], ["E", "B"]])
    expect([...depth].sort()).toEqual([["A", 0], ["B", 1], ["C", 2], ["D", 1], ["E", 2]])
    expect(p.rank.get("D")).toBe(3)
    expect(flowColumns({ nodes: ["A", "B", "C", "D", "E"].map((id) => node(id)), edges: [["A", "B"], ["B", "C"], ["C", "D"], ["A", "D"], ["B", "E"], ["C", "E"]] })).toBe(3)
  })

  it("thành phần liên thông mạnh: đại diện không phải pop-up khi có màn khác", () => {
    expect(plan(["P", "Q"], [["P", "Q"], ["Q", "P"]], ["P"]).entries).toEqual(["Q"])
  })
})

const node = (id: string, over: Partial<FlowNode> = {}): FlowNode => ({ id, name: `Screen ${id}`, popup: false, tabs: [], shared: false, ...over })
type Path = Extract<SceneElement, { type: "path" }>
const path = (scene: ReturnType<typeof layoutScreenFlow>, id: string): Path => scene.find(id) as Path
const lastPoint = (p: Path) => p.points[p.points.length - 1]
/** Id các đường của cạnh (`flow:<từ>><tới>`), bỏ phần phụ (`#end`…). */
const ids = (scene: ReturnType<typeof layoutScreenFlow>): string[] => scene.elements.filter((e) => e.id.startsWith("flow:") && !e.id.includes("#")).map((e) => e.id)

describe("layoutScreenFlow — ký pháp template FPT", () => {
  const home: FlowDiagram = {
    nodes: [node("H", { name: "Home", shared: true }), node("L", { name: "Login", shared: true }), node("B", { name: "Blogs" }), node("P", { name: "Import", popup: true }), node("O", { name: "Order Details", tabs: ["Products Info", "Receiver Info"] })],
    edges: [["H", "L"], ["H", "B"], ["H", "P"], ["B", "O"]]
  }

  it("màn = chữ nhật góc vuông; pop-up = ô-van; màn nhiều tab = khung chứa + hộp tab chữ nghiêng", () => {
    const scene = layoutScreenFlow(home)
    expect(scene.find("B")).toMatchObject({ type: "rect", radius: 0, container: false })
    expect(scene.find("P")).toMatchObject({ type: "ellipse" })
    expect(scene.find("O")).toMatchObject({ type: "rect", container: true })
    expect(scene.find("O#tab0")).toMatchObject({ type: "rect", fill: "#fff" })
    expect(scene.find("O#tab1#t0")).toMatchObject({ type: "text", italic: true, text: "Receiver Info" })
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  it("màn dùng chung tô #7ACFF5, màn còn lại nền trắng", () => {
    const scene = layoutScreenFlow(home)
    expect(scene.find("H")).toMatchObject({ fill: "#7ACFF5" })
    expect(scene.find("L")).toMatchObject({ fill: "#7ACFF5" })
    expect(scene.find("B")).toMatchObject({ fill: "#fff" })
    expect(scene.find("O")).toMatchObject({ fill: "#fff" })
  })

  it("không làn, không nhãn, không initial / final / decision; đầu mũi tên tam giác đặc", () => {
    const scene = layoutScreenFlow(home)
    expect(scene.elements.some((e) => /^(lane|initial|final|decision):/.test(e.id) || e.id.includes("#label"))).toBe(false)
    expect(scene.find("flow:H>B#end")).toMatchObject({ closed: true, fill: "#000" })
    expect(scene.toSvg()).not.toContain("stroke-dasharray")
  })

  it("một nguồn nhiều đích ở cột kế ⇒ một trục chung + mỗi đích một nhánh ngang tới cạnh trái đích", () => {
    const scene = layoutScreenFlow(home)
    expect(scene.find("bus:H")).toBeDefined()
    expect(scene.find("bus:H#trunk")).toBeDefined()
    const trunk = path(scene, "bus:H#trunk")
    for (const to of ["L", "B", "P"]) {
      const branch = path(scene, `flow:H>${to}`)
      expect(branch.points).toHaveLength(2)
      expect(branch.points[0][0]).toBe(trunk.points[0][0])
      expect(branch.points[0][1]).toBe(branch.points[1][1])
    }
    const b = scene.find("B") as Extract<SceneElement, { type: "rect" }>
    expect(lastPoint(path(scene, "flow:H>B"))[0]).toBe(b.x)
  })

  it("cha và con đầu tiên cùng hàng; cạnh duy nhất thẳng hàng là một đoạn thẳng", () => {
    const scene = layoutScreenFlow({ nodes: [node("A"), node("B"), node("C")], edges: [["A", "B"], ["B", "C"]] })
    for (const id of ["flow:A>B", "flow:B>C"]) expect(path(scene, id).points).toHaveLength(2)
    expect(scene.find("bus:A")).toBeUndefined()
    const ys = ["A", "B", "C"].map((id) => scene.find(id) as Extract<SceneElement, { type: "rect" }>).map((r) => r.y + r.h / 2)
    expect(new Set(ys).size).toBe(1)
  })

  it("chỉ vẽ cây: mỗi màn một đường vào từ màn cha (đường vào nông nhất); lối vào khác không vẽ", () => {
    const scene = layoutScreenFlow({ nodes: [node("A"), node("B"), node("C"), node("D")], edges: [["A", "B"], ["B", "C"], ["A", "C"], ["C", "D"], ["A", "D"]] })
    expect(ids(scene).sort()).toEqual(["flow:A>B", "flow:A>C", "flow:A>D"])
    // con ở cột ngay sau cha
    const xs = ["B", "C", "D"].map((id) => (scene.find(id) as Extract<SceneElement, { type: "rect" }>).x)
    expect(new Set(xs).size).toBe(1)
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  it("màn gốc mà mọi đích đã có cha khác vẫn giữ đường ra đầu tiên, không trơ trọi", () => {
    // Login → Dashboard là cạnh cây; Onboarding → Dashboard không phải nhưng là đường duy nhất của Onboarding
    const scene = layoutScreenFlow({ nodes: [node("L"), node("D"), node("O"), node("X")], edges: [["L", "D"], ["O", "D"], ["O", "X"], ["L", "X"]] })
    expect(ids(scene).sort()).toEqual(["flow:L>D", "flow:L>X", "flow:O>D"])
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  it("pop-up nhiều màn mở: mọi màn mở đều vẽ; các đường xa vào cùng phía gộp một trục thu, chung một mũi tên", () => {
    const scene = layoutScreenFlow({
      nodes: [node("A"), node("B"), node("C"), node("D"), node("P", { popup: true })],
      edges: [["A", "B"], ["A", "P"], ["B", "C"], ["B", "D"], ["C", "P"], ["D", "P"]]
    })
    expect(ids(scene).sort()).toEqual(["flow:A>B", "flow:A>P", "flow:B>C", "flow:B>D", "flow:C>P", "flow:D>P"])
    expect(scene.find("collect:P:up")).toBeDefined()
    expect(scene.find("collect:P:up#trunk")).toBeDefined()
    expect(scene.find("collect:P:up#end")).toBeDefined()
    for (const id of ["flow:C>P", "flow:D>P"]) {
      expect(path(scene, id).points).toHaveLength(2)
      expect(scene.find(`${id}#end`)).toBeUndefined()
    }
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  // 600 đồ thị + kiểm từng đầu mũi tên: chạy song song với cả bộ test có thể quá 5s mặc định
  it("không đường nào xuyên hình, đè chữ hay chồng nhau; mọi đoạn song song trục (ngẫu nhiên, có seed)", { timeout: 120_000 }, () => {
    let seed = 7
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
    for (let t = 0; t < 600; t++) {
      const n = 1 + Math.floor(rnd() * 40)
      const nodes = Array.from({ length: n }, (_, i) =>
        node(`S${i}`, {
          name: `Screen ${i} ${"word ".repeat(Math.floor(rnd() * 12))}`,
          popup: rnd() < 0.15,
          tabs: rnd() < 0.12 ? ["Chat", "Document", "History"].slice(0, 1 + Math.floor(rnd() * 3)) : [],
          shared: rnd() < 0.3
        })
      )
      const edges = Array.from({ length: Math.floor(rnd() * n * 2.2) }, (): [string, string] => [`S${Math.floor(rnd() * n)}`, `S${Math.floor(rnd() * n)}`])
      const scene = layoutScreenFlow({ nodes, edges })
      expect(checkScene(scene, { allowBends: true }), `case ${t}`).toEqual([])
      // `checkScene` không kiểm đầu mũi tên (decoration): hai đầu không chạm nhau, đầu không đè đường khác
      const heads = scene.elements.filter((e): e is Path => e.type === "path" && e.id.endsWith("#end"))
      const lines = scene.elements.filter((e): e is Path => e.type === "path" && e.role === "connector")
      for (const [i, h] of heads.entries()) {
        for (const other of heads.slice(i + 1)) expect(overlaps(outline(h), outline(other), 0.5), `case ${t} ${h.id} / ${other.id}`).toBe(false)
        for (const line of lines) {
          if (`${line.id}#end` === h.id) continue
          const segs = line.points.slice(1).map((p, k): Point[] => [line.points[k], p])
          expect(segs.some((seg) => overlaps(outline(h), seg, 0.5)), `case ${t} ${h.id} đè ${line.id}`).toBe(false)
        }
      }
      // vẽ đúng cạnh cây + mọi cạnh mở pop-up (+ đường ra đầu của màn gốc trơ trọi), không cạnh nào khác
      const plan = planFlow(nodes.map((x) => x.id), new Set(nodes.filter((x) => x.popup).map((x) => x.id)), edges)
      const { parent } = flowTree(plan)
      const popups = new Set(nodes.filter((x) => x.popup).map((x) => x.id))
      const tree = plan.edges.filter(([from, to]) => parent.get(to) === from || popups.has(to))
      // màn gốc không có đường cây nào giữ đường ra đầu tiên
      const lone = nodes.map((x) => x.id).filter((id) => !parent.has(id) && !tree.some(([from]) => from === id)).flatMap((id) => plan.edges.filter(([from]) => from === id).slice(0, 1))
      const expected = [...tree, ...lone].map(([from, to]) => `flow:${from}>${to}`)
      expect(ids(scene).sort(), `case ${t}`).toEqual(expected.sort())
    }
  })
})
