import { describe, expect, it } from "vitest"
import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import type { Point } from "../../../shared/diagram/svg-kit.js"
import type { Scene, SceneElement } from "../../../shared/diagram/svg-scene.js"
import { layoutActorHierarchy, layoutUseCaseDiagram, wrapLines, type DiagramActor, type UseCaseDiagram } from "./usecase-layout.js"

type Ellipse = Extract<SceneElement, { type: "ellipse" }>
type Path = Extract<SceneElement, { type: "path" }>

const ellipses = (scene: Scene): Ellipse[] => scene.elements.filter((e): e is Ellipse => e.type === "ellipse" && e.id.startsWith("uc:"))
const paths = (scene: Scene, prefix: string): Path[] => scene.elements.filter((e): e is Path => e.type === "path" && e.id.startsWith(prefix) && !e.id.includes("#"))
const arrowOf = (scene: Scene, id: string): Path => scene.elements.find((e): e is Path => e.id === `${id}#end`)!

const human = (id: string, name = `Actor ${id}`): DiagramActor => ({ id, name, kind: "human", abstract: false })
const system = (id: string, name = `System ${id}`): DiagramActor => ({ id, name, kind: "system", abstract: false })

/** Điểm trên đoạn thẳng nằm trong ellipse (lùi vào 1px) — chạm đỉnh ở hai đầu không tính. */
const enters = (a: Point, b: Point, e: Ellipse): boolean => {
  for (let i = 1; i < 200; i++) {
    const t = i / 200
    const x = a[0] + (b[0] - a[0]) * t
    const y = a[1] + (b[1] - a[1]) * t
    if (((x - e.cx) / (e.rx - 1)) ** 2 + ((y - e.cy) / (e.ry - 1)) ** 2 < 1) return true
  }
  return false
}

const rowsOf = (n: number, name = (i: number) => `Create Item ${i}`) => Array.from({ length: n }, (_, i) => ({ id: `UC${String(i + 1).padStart(2, "0")}`, name: name(i + 1) }))

/** Bất biến hình học của một sơ đồ use case. */
const expectInvariants = (d: UseCaseDiagram, scene: Scene): void => {
  expect(checkScene(scene, { allowBends: false })).toEqual([])
  const es = ellipses(scene)
  expect(es).toHaveLength(d.rows.length)
  // mọi ellipse cùng rx, ry, cx
  expect(new Set(es.map((e) => e.rx)).size).toBe(1)
  expect(new Set(es.map((e) => e.ry)).size).toBe(1)
  expect(new Set(es.map((e) => e.cx)).size).toBe(1)
  // mỗi association một đoạn thẳng, không cắt ellipse nào ngoài đích
  for (const link of d.associations) {
    const line = scene.find(`${link.actorId}~${link.useCaseId}`) as Path
    expect(line.points).toHaveLength(2)
    expect(line.dashed).toBe(false)
    expect(scene.find(`${line.id}#end`)).toBeUndefined() // association không đầu mũi tên
    for (const e of es) expect(enters(line.points[0], line.points[1], e), `${line.id} cắt ${e.id}`).toBe(false)
    const target = es.find((e) => e.id === `uc:${link.useCaseId}`)!
    const actor = d.actors.find((a) => a.id === link.actorId)!
    const tip = line.points[1]
    expect(tip[1]).toBe(target.cy)
    expect(tip[0]).toBe(actor.kind === "human" ? target.cx - target.rx : target.cx + target.rx)
  }
  // actor người bên trái, actor system/time bên phải, đều ngoài khung
  const boundary = scene.find("system") as Extract<SceneElement, { type: "rect" }>
  for (const a of d.actors) {
    const head = scene.find(`actor:${a.id}#head`) as Ellipse
    if (a.kind === "human") expect(head.cx + head.rx).toBeLessThan(boundary.x)
    else expect(head.cx - head.rx).toBeGreaterThan(boundary.x + boundary.w)
  }
  // include / extend: đoạn dọc giữa hai ellipse kề nhau, nét đứt, mũi tên hở ở đầu `to`
  for (const rel of d.relations) {
    const id = `${rel.kind}:${rel.from}>${rel.to}`
    const line = scene.find(id) as Path
    const [from, to] = [es.find((e) => e.id === `uc:${rel.from}`)!, es.find((e) => e.id === `uc:${rel.to}`)!]
    expect(line.dashed).toBe(true)
    expect(line.points).toHaveLength(2)
    expect(line.points[0][0]).toBe(from.cx)
    expect(line.points[1][0]).toBe(to.cx)
    const down = to.cy > from.cy
    expect(line.points[0][1]).toBe(from.cy + (down ? from.ry : -from.ry))
    expect(line.points[1][1]).toBe(to.cy + (down ? -to.ry : to.ry))
    expect(Math.abs(to.cy - from.cy)).toBe(2 * from.ry + 30) // hai hàng kề nhau
    const head = arrowOf(scene, id)
    expect(head.closed).toBe(false) // V hở, không tô
    expect(head.points[1]).toEqual(line.points[1])
    expect(scene.find(`${id}#label`)).toBeDefined()
  }
}

const assoc = (pairs: [string, string][]) => pairs.map(([actorId, useCaseId]) => ({ actorId, useCaseId }))

describe("layoutUseCaseDiagram", () => {
  it("mẫu Account Access: association thẳng, extend kề nhau, bất biến ellipse", () => {
    const d: UseCaseDiagram = {
      system: "FlintFlow",
      rows: [
        { id: "R", name: "Register Account" },
        { id: "V", name: "Verify Email Address" },
        { id: "L", name: "Log In" },
        { id: "P", name: "Reset Password" },
        { id: "C", name: "Change Password" },
        { id: "O", name: "Log Out" }
      ],
      actors: [human("G", "Guest"), { ...human("U", "Registered User"), abstract: true }, system("I", "Identity Provider"), system("E", "Email Service")],
      associations: assoc([["G", "R"], ["G", "L"], ["G", "P"], ["U", "C"], ["U", "O"], ["I", "R"], ["I", "L"], ["E", "R"], ["E", "V"], ["E", "P"]]),
      relations: [
        { from: "V", to: "R", kind: "extend" },
        { from: "V", to: "L", kind: "extend" }
      ]
    }
    const scene = layoutUseCaseDiagram(d)
    expectInvariants(d, scene)
    // hai extend đều xuất phát từ Verify Email Address: một đi lên, một đi xuống
    expect((scene.find("extend:V>R") as Path).points[1][1]).toBeLessThan((scene.find("extend:V>R") as Path).points[0][1])
    expect((scene.find("extend:V>L") as Path).points[1][1]).toBeGreaterThan((scene.find("extend:V>L") as Path).points[0][1])
    const svg = scene.toSvg()
    expect(svg).toContain("&lt;&lt;extend&gt;&gt;")
    expect(svg).toMatch(/font-style="italic"[^>]*>Registered User</)
    expect(svg).toContain("&lt;&lt;system&gt;&gt;")
    expect(svg).toContain('fill="#7ACFF5"')
  })

  it("ca biên: nhiều actor hai bên, mỗi actor nối vài use case xa nhau", () => {
    const rows = rowsOf(12)
    const left = Array.from({ length: 6 }, (_, i) => human(`H${i}`, `Human Role ${i}`))
    const right = Array.from({ length: 4 }, (_, i) => (i % 2 ? { ...system(`S${i}`), kind: "time" as const } : system(`S${i}`)))
    const associations = [...left, ...right].flatMap((a, ai) => rows.filter((_, i) => (i + ai) % 4 === 0).map((r) => ({ actorId: a.id, useCaseId: r.id })))
    const d: UseCaseDiagram = { system: "Dense", rows, actors: [...left, ...right], associations, relations: [] }
    expectInvariants(d, layoutUseCaseDiagram(d))
  })

  it("ca biên: tên dài tự xuống dòng, vẫn một cỡ ellipse, không tràn chữ", () => {
    const long = "Configure The Automatic Synchronisation Of Every Customer Record With The External Accounting Platform"
    const d: UseCaseDiagram = {
      system: "A Very Long System Name That Is Wider Than The Ellipse Column Of This Diagram Indeed",
      rows: [{ id: "A", name: long }, { id: "B", name: "Log In" }, { id: "C", name: `${long} Again` }],
      actors: [human("H", "Student Services Office Staff Member With A Long Title"), system("S", "Payment Gateway Of The Partner Bank")],
      associations: assoc([["H", "A"], ["H", "C"], ["S", "B"]]),
      relations: [{ from: "B", to: "C", kind: "include" }]
    }
    const scene = layoutUseCaseDiagram(d)
    expectInvariants(d, scene)
    expect(wrapLines(long, 16, 230, 3).length).toBeGreaterThan(1)
  })

  it("một use case, một actor, không quan hệ", () => {
    const d: UseCaseDiagram = { system: "S", rows: rowsOf(1), actors: [human("H")], associations: assoc([["H", "UC01"]]), relations: [] }
    expectInvariants(d, layoutUseCaseDiagram(d))
  })

  it("quan hệ giữa hai use case không kề nhau ⇒ ném (lỗi của bộ chia hình), association tới phần tử lạ ⇒ ném", () => {
    const base: UseCaseDiagram = { system: "S", rows: rowsOf(3), actors: [human("H")], associations: assoc([["H", "UC01"]]), relations: [] }
    expect(() => layoutUseCaseDiagram({ ...base, relations: [{ from: "UC01", to: "UC03", kind: "include" }] })).toThrow(/kề nhau/)
    expect(() => layoutUseCaseDiagram({ ...base, associations: assoc([["H", "UC99"]]) })).toThrow(/không có trong hình/)
  })

  it("tất định: cùng đầu vào ⇒ cùng SVG", () => {
    const d: UseCaseDiagram = { system: "S", rows: rowsOf(4), actors: [human("H"), system("S1")], associations: assoc([["H", "UC01"], ["S1", "UC04"]]), relations: [{ from: "UC02", to: "UC03", kind: "extend" }] }
    expect(layoutUseCaseDiagram(d).toSvg()).toBe(layoutUseCaseDiagram(d).toSvg())
  })
})

describe("layoutActorHierarchy", () => {
  const actor = (id: string, abstract = false) => ({ id, name: `Role ${id}`, abstract })

  it("cây nhiều tầng: con dưới cha, mỗi cạnh một đoạn thẳng đầu tam giác rỗng ở phía cha, không lỗi bố cục", () => {
    const actors = [actor("G"), actor("R", true), actor("M", true), actor("Ad"), actor("Au", true), actor("V"), actor("An"), actor("L")]
    const parents = new Map([["M", "R"], ["Ad", "R"], ["Au", "M"], ["V", "M"], ["An", "Au"], ["L", "Au"]])
    const scene = layoutActorHierarchy(actors, parents)
    expect(checkScene(scene, { allowBends: false })).toEqual([])
    const edges = paths(scene, "gen:")
    expect(edges).toHaveLength(parents.size)
    for (const edge of edges) {
      expect(edge.points).toHaveLength(2)
      expect(edge.dashed).toBe(false)
      const head = arrowOf(scene, edge.id)
      expect(head.closed).toBe(true)
      expect(head.fill).toBe("#fff") // tam giác rỗng
      // đầu mũi tên ở phía cha, phía trên đầu actor con
      expect(edge.points[1][1]).toBeLessThan(edge.points[0][1])
    }
    const headY = (id: string) => (scene.find(`actor:${id}#head`) as Ellipse).cy
    for (const [child, parent] of parents) expect(headY(child)).toBeGreaterThan(headY(parent))
    expect(scene.toSvg()).toMatch(/font-style="italic"[^>]*>Role R</)
  })

  it("không có cạnh nào: chỉ các hình que, không đường", () => {
    const scene = layoutActorHierarchy([actor("A"), actor("B")], new Map())
    expect(paths(scene, "gen:")).toHaveLength(0)
    expect(checkScene(scene, { allowBends: false })).toEqual([])
  })

  it("nhiều gốc và cây rộng không chồng nhau", () => {
    const actors = [actor("P1"), actor("P2"), ...Array.from({ length: 8 }, (_, i) => actor(`C${i}`))]
    const parents = new Map(actors.slice(2).map((c, i): [string, string] => [c.id, i < 5 ? "P1" : "P2"]))
    expect(checkScene(layoutActorHierarchy(actors, parents), { allowBends: false })).toEqual([])
  })
})

describe("wrapLines", () => {
  it("vừa một dòng hoặc một từ ⇒ giữ nguyên; dài ⇒ chia cân, tối đa maxLines", () => {
    expect(wrapLines("Log In", 16, 230, 3)).toEqual(["Log In"])
    expect(wrapLines("Supercalifragilisticexpialidocious", 16, 50, 3)).toEqual(["Supercalifragilisticexpialidocious"])
    const lines = wrapLines("Generate The Complete Software Requirements Specification Document", 16, 230, 3)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.length).toBeLessThanOrEqual(3)
    expect(lines.join(" ")).toBe("Generate The Complete Software Requirements Specification Document")
  })
})
