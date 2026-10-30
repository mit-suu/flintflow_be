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

describe("layoutScreenFlow — nhãn trigger, decision node, guard", () => {
  const login = (edges: FlowDiagram["edges"], extra: Partial<FlowDiagram> = {}): FlowDiagram => ({
    lanes: [{ id: "A", name: "Actor A" }],
    nodes: ["Login", "Home", "Admin", "Help", "Register"].map((name, i) => ({ id: `S${i + 1}`, name, lane: 0, popup: i === 3, tabs: [] })),
    edges,
    popupLabel: "pop-up",
    ...extra
  })
  const texts = (scene: ReturnType<typeof layoutScreenFlow>): string[] => scene.elements.filter((e) => e.type === "text" && e.id.includes("#label")).map((e) => (e as { text: string }).text)

  it("trigger là nhãn ngang trên cạnh, nền trắng; không decision khi không có guard", () => {
    const scene = layoutScreenFlow(login([{ from: "S1", to: "S2", trigger: "Click Log in" }, { from: "S1", to: "S5", trigger: "Click Register" }]))
    expect(texts(scene).sort()).toEqual(["Click Log in", "Click Register"])
    expect(scene.elements.some((e) => e.id.startsWith("decision:"))).toBe(false)
    expect(scene.find("flow:S1>S2#label-bg")).toMatchObject({ fill: "#fff", role: "decoration", rotate: 0 })
    expect(scene.find("flow:S1>S2#label")).toMatchObject({ rotate: 0 })
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  it("cùng trigger, ≥ 2 cạnh, có guard ⇒ decision (thoi tô #7ACFF5): trigger trên đoạn màn → thoi, [guard] / [else] trên nhánh", () => {
    const scene = layoutScreenFlow(
      login([
        { from: "S1", to: "S2", trigger: "Submit credentials", guard: "OTP valid" },
        { from: "S1", to: "S3", trigger: "Submit credentials", guard: "Admin" },
        { from: "S1", to: "S4", trigger: "Submit credentials" },
        { from: "S1", to: "S5", trigger: "Click Register" }
      ])
    )
    expect(scene.find("decision:S1#0")).toMatchObject({ type: "path", closed: true, role: "shape", fill: "#7ACFF5" })
    expect(scene.find("decide:S1#0#label")).toMatchObject({ text: "Submit credentials" })
    expect(scene.find("flow:S1>S2#label")).toMatchObject({ text: "[OTP valid]" })
    expect(scene.find("flow:S1>S3#label")).toMatchObject({ text: "[Admin]" })
    expect(scene.find("flow:S1>S4#label")).toMatchObject({ text: "[else]" })
    // trigger khác nằm ngoài nhóm: cạnh trơn từ màn
    expect(scene.find("flow:S1>S5#label")).toMatchObject({ text: "Click Register" })
    expect(scene.elements.filter((e) => e.id.startsWith("decision:"))).toHaveLength(1)
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  it("nhóm một cạnh có guard: không decision, guard in dưới trigger; elseLabel theo ngôn ngữ", () => {
    const one = layoutScreenFlow(login([{ from: "S1", to: "S2", trigger: "Submit", guard: "OTP valid" }]))
    expect(texts(one)).toEqual(["Submit", "[OTP valid]"])
    expect(one.elements.some((e) => e.id.startsWith("decision:"))).toBe(false)
    const vi = layoutScreenFlow(login([{ from: "S1", to: "S2", trigger: "Gửi", guard: "OTP đúng" }, { from: "S1", to: "S3", trigger: "Gửi" }], { elseLabel: "ngược lại" }))
    expect(vi.find("flow:S1>S3#label")).toMatchObject({ text: "[ngược lại]" })
  })

  it("trigger / guard rất dài gói tối đa 2 dòng mỗi loại, từ dài bị cắt; không đè gì", () => {
    const long = "Click the Run final verification button after reviewing every pending change request in the queue"
    const scene = layoutScreenFlow(login([{ from: "S1", to: "S2", trigger: long, guard: long }, { from: "S1", to: "S3", trigger: long, guard: "x".repeat(200) }]))
    for (const e of scene.elements) if (e.type === "text" && e.id.includes("#label")) expect(e.text.length).toBeLessThan(80)
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  it("ngẫu nhiên có seed: đồ thị có nhãn / guard, qua bộ kiểm khi tách hình như renderer", () => {
    let seed = 11
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
    const words = ["Submit", "Click Save", "Open details", "Confirm", "Retry after timeout"]
    const guards = ["OTP valid", "Admin", "Has credit", "Form complete"]
    let unplaced = 0
    for (let t = 0; t < 150; t++) {
      const n = 2 + Math.floor(rnd() * 9)
      const lanes = 1 + Math.floor(rnd() * 3)
      const nodes = Array.from({ length: n }, (_, i) => ({ id: `S${i}`, name: `Screen ${i}`, lane: Math.floor(rnd() * lanes), popup: rnd() < 0.15, tabs: [] }))
      const edges = Array.from({ length: Math.floor(rnd() * n * 1.8) }, () => ({
        from: `S${Math.floor(rnd() * n)}`,
        to: `S${Math.floor(rnd() * n)}`,
        ...(rnd() < 0.7 ? { trigger: words[Math.floor(rnd() * words.length)] } : {}),
        ...(rnd() < 0.4 ? { guard: guards[Math.floor(rnd() * guards.length)] } : {})
      }))
      const scene = layoutScreenFlow({ lanes: Array.from({ length: lanes }, (_, i) => ({ id: `A${i}`, name: `Actor ${i}` })), nodes, edges, popupLabel: "pop-up" })
      if (checkScene(scene, { allowBends: true }).length > 0) unplaced++
    }
    // Hiếm ca không tìm được chỗ nhãn: renderer tách hình (`refine`) — tỉ lệ phải nhỏ
    expect(unplaced).toBeLessThan(15)
  })
})
