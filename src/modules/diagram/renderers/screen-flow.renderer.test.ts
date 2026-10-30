import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Screen, Spine } from "../../spine/spine.types.js"
import { svgTitleOf } from "./common.js"
import { RENDERERS, renderKind } from "./index.js"
import { MAX_SCREENS_PER_DIAGRAM, partitionScreenFlow, SCREEN_FLOW_SECTION } from "./screen-flow.renderer.js"
import { layoutScreenFlow } from "./screen-flow-layout.js"
import { DIAGRAM_LABELS } from "./labels.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const mutate = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}
const screen = (n: number, extra: Partial<Screen> = {}): Screen => ({
  id: `S${String(n).padStart(3, "0")}`,
  feature_id: "F1",
  name: `Screen ${n}`,
  description: "",
  flow_to: [],
  is_popup: false,
  tabs: [],
  primary_function_id: null,
  queue_order: n,
  detail_status: "placeholder",
  ...extra
})
const fn = (id: string, screenId: string): Spine["functions"][number] => ({
  id,
  screen_id: screenId,
  feature_id: "F1",
  order: 0,
  name: id,
  trigger: "",
  description: "",
  normal: [],
  abnormal: [],
  validations: [],
  business_rule_ids: [],
  priority: null
})
/** Spine nhỏ: một feature, màn S001…Snnn nối chuỗi, mọi màn thuộc actor A01 qua use case. */
const chain = (count: number, extra: (s: Spine) => void = () => undefined): Spine =>
  mutate((s) => {
    s.screens = Array.from({ length: count }, (_, i) => screen(i + 1, { flow_to: i + 1 < count ? [{ to: `S${String(i + 2).padStart(3, "0")}` }] : [] }))
    s.functions = s.screens.map((x, i) => fn(`FNX${i}`, x.id))
    s.use_cases = [{ id: "UCX", name: "Do It", actor_ids: ["A01"], function_ids: s.functions.map((f) => f.id), description: "", includes: [], extends: [] }]
    s.features = [{ id: "F1", name: "Only Feature", order: 0 }]
    s.permissions = []
    extra(s)
  })
const sceneOf = (spine: Spine) => partitionScreenFlow(spine).map(({ diagram }) => layoutScreenFlow(diagram))
const ids = (scene: ReturnType<typeof layoutScreenFlow>, prefix: string): string[] =>
  scene.elements.filter((e) => e.id.startsWith(prefix) && !e.id.includes("#")).map((e) => e.id)

describe("screen_flow — chia hình theo feature, làn theo actor", () => {
  it("fixture: mỗi feature một hình svg, tiêu đề theo feature, issues rỗng", () => {
    const parts = renderKind(FIXTURE, "screen_flow")
    expect(parts).toHaveLength(FIXTURE.features.length)
    expect(parts.every((p) => p.format === "svg" && p.section === SCREEN_FLOW_SECTION && p.owner_id === null && p.owner_kind === null)).toBe(true)
    expect(parts.map((p) => svgTitleOf(p.source))).toEqual(FIXTURE.features.map((f) => DIAGRAM_LABELS.en.screensFlowTitle(f.name)))
    for (const p of parts) expect(p.issues).toEqual([])
  })

  it("làn = tên actor; màn vào có initial, màn cuối có activity final; mỗi flow_to trong hình một cạnh tiến", () => {
    const [auth] = partitionScreenFlow(FIXTURE)
    expect(auth.diagram.lanes.map((l) => l.name)).toEqual(["Founder", "Guest"])
    const scene = layoutScreenFlow(auth.diagram)
    const f1 = FIXTURE.screens.filter((s) => s.feature_id === "F1")
    // Login ⇄ Register: chỉ giữ chiều đi tiếp từ màn vào; S01 → S05 / S14 sang feature khác không vẽ
    expect(ids(scene, "flow:")).toEqual(["flow:S01>S02", "flow:S01>S03"])
    expect(ids(scene, "start:")).toEqual(["start:S01", "start:S04"])
    expect(ids(scene, "end:").sort()).toEqual(["end:S02", "end:S03", "end:S04"])
    for (const id of ids(scene, "flow:")) {
      const [from, to] = id.slice(5).split(">")
      expect(f1.find((s) => s.id === from)!.flow_to.map((e) => e.to)).toContain(to)
    }
    expect(scene.find("lane:A01")).toBeDefined()
    expect(scene.find("lane:A04")).toBeDefined()
  })

  it("pop-up là action có stereotype ASCII <<pop-up>>, màn nhiều tab có dòng [tab | tab]; không ô-van", () => {
    const svg = renderKind(FIXTURE, "screen_flow").map((p) => p.source).join("\n")
    expect(svg).toContain("&lt;&lt;pop-up&gt;&gt;")
    expect(svg).toContain("[Chat |")
    expect(svg).not.toContain("<ellipse")
  })

  it("màn không có actor người nào không vẽ; chưa có liên kết màn ↔ actor ⇒ vẽ không làn", () => {
    const orphan = chain(3, (s) => s.screens.push(screen(4)))
    const [part] = partitionScreenFlow(orphan)
    expect(part.diagram.nodes.map((n) => n.id)).toEqual(["S001", "S002", "S003"])

    const unlinked = chain(3, (s) => (s.use_cases = []))
    const [single] = partitionScreenFlow(unlinked)
    expect(single.diagram.lanes).toEqual([])
    expect(single.diagram.nodes).toHaveLength(3)
    expect(checkScene(layoutScreenFlow(single.diagram), { allowBends: true })).toEqual([])
    expect(renderKind(unlinked, "screen_flow")[0].source).not.toContain("font-weight")
  })

  it("actor mơ hồ vẫn vẽ được: chọn actor đầu tiên theo thứ tự actor_ids", () => {
    const spine = chain(2, (s) => {
      s.use_cases[0].actor_ids = ["A02", "A01"]
    })
    const [part] = partitionScreenFlow(spine)
    expect(part.diagram.lanes.map((l) => l.id)).toEqual(["A02"])
    expect(renderKind(spine, "screen_flow")[0].issues).toEqual([])
  })

  it("actor cùng cha ⇒ làn của actor cha, không bung xuống actor lá", () => {
    const spine = chain(3, (s) => {
      s.actors.push({ id: "A90", name: "User", kind: "human", description: "Founder and Business Analyst" })
      s.actors.find((a) => a.id === "A01")!.parent_id = "A90"
      s.actors.find((a) => a.id === "A02")!.parent_id = "A90"
      s.use_cases[0].actor_ids = ["A01", "A02"]
    })
    const [part] = partitionScreenFlow(spine)
    expect(part.diagram.lanes).toEqual([{ id: "A90", name: "User" }])
  })

  it("> 25 màn trong một feature ⇒ tách đều, tiêu đề (i/n), mọi màn đúng một lần, issues rỗng", () => {
    const spine = chain(60)
    const parts = partitionScreenFlow(spine)
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.map((p) => p.title)).toEqual(parts.map((_, i) => DIAGRAM_LABELS.en.screensFlowTitle(`Only Feature (${i + 1}/${parts.length})`)))
    expect(parts.every((p) => p.diagram.nodes.length <= MAX_SCREENS_PER_DIAGRAM)).toBe(true)
    expect(parts.flatMap((p) => p.diagram.nodes.map((n) => n.id)).sort()).toEqual(spine.screens.map((s) => s.id).sort())
    for (const p of renderKind(spine, "screen_flow")) expect(p.issues).toEqual([])
  })

  it("tên màn rất dài, nhiều làn: không tràn, issues rỗng", () => {
    const spine = chain(6, (s) => {
      s.screens[1].name = "A ridiculously long screen name that keeps going and going well past any sensible width"
      s.screens[2].name = "Unbrokenwordthatisfarlongerthanthenodewidthcanholdwithoutwrappinganywhere"
      s.screens[3].tabs = ["Overview", "Members and permissions", "Billing", "Audit trail", "Danger zone"]
      for (const [i, id] of ["A01", "A02", "A04", "A03"].entries()) {
        s.functions.push(fn(`FNL${i}`, s.screens[i].id))
        s.screens[i].primary_function_id = `FNL${i}`
        s.use_cases.push({ id: `UCL${i}`, name: `Do ${i}`, actor_ids: [id], function_ids: [`FNL${i}`], description: "", includes: [], extends: [] })
      }
    })
    const [part] = renderKind(spine, "screen_flow")
    expect(partitionScreenFlow(spine)[0].diagram.lanes.length).toBeGreaterThan(2)
    expect(part.issues).toEqual([])
  })

  it("cạnh quay lại và trỏ qua lại không vẽ hai chiều; đồ thị có vòng vẫn sạch", () => {
    const spine = chain(5, (s) => {
      s.screens[4].flow_to = [{ to: "S001" }, { to: "S003" }]
      s.screens[2].flow_to.push({ to: "S002" }, { to: "S005" }, { to: "S001" })
    })
    const [scene] = sceneOf(spine)
    expect(ids(scene, "flow:")).toEqual(["flow:S001>S002", "flow:S002>S003", "flow:S003>S004", "flow:S003>S005", "flow:S004>S005"])
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  it("không có màn ⇒ không có hình; renderer thuần (cùng Spine ⇒ cùng nguồn)", () => {
    expect(renderKind(mutate((s) => (s.screens = [])), "screen_flow")).toEqual([])
    expect(renderKind(FIXTURE, "screen_flow").map((p) => p.source)).toEqual(renderKind(FIXTURE, "screen_flow").map((p) => p.source))
  })
})

describe("screen_flow — trigger và guard của flow_to", () => {
  const withEdges = (): Spine =>
    chain(4, (s) => {
      s.screens[0].flow_to = [
        { to: "S002", trigger: "Submit credentials", guard: "OTP valid" },
        { to: "S003", trigger: "Submit credentials", guard: "Admin" },
        { to: "S004", trigger: "Submit credentials" }
      ]
      s.screens[1].flow_to = []
      s.screens[2].flow_to = []
    })

  it("rẽ nhánh qua decision node, guard trên nhánh, nhánh không guard là else; issues rỗng", () => {
    const spine = withEdges()
    const [part] = renderKind(spine, "screen_flow")
    expect(part.issues).toEqual([])
    const [scene] = sceneOf(spine)
    expect(scene.find("decision:S001#0")).toBeDefined()
    expect(scene.find("flow:S001>S002#label")).toMatchObject({ text: "[OTP valid]" })
    expect(scene.find("flow:S001>S004#label")).toMatchObject({ text: "[else]" })
    expect(scene.find("decide:S001#0#label")).toMatchObject({ text: "Submit credentials" })
  })

  it("bản tiếng Việt dùng [ngược lại]; đổi trigger / guard đổi hình (khác nguồn)", () => {
    const spine = withEdges()
    const vi = RENDERERS.screen_flow(spine, null, DIAGRAM_LABELS.vi)[0].source
    expect(vi).toContain("[ngược lại]")
    const changed = withEdges()
    changed.screens[0].flow_to[0].guard = "OTP correct"
    expect(renderKind(changed, "screen_flow")[0].source).not.toBe(renderKind(spine, "screen_flow")[0].source)
  })
})
