import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Screen, Spine } from "../../spine/spine.types.js"
import { svgTitleOf } from "./common.js"
import { renderKind } from "./index.js"
import { MAX_COLUMNS, MAX_SCREENS_PER_DIAGRAM, partitionScreenFlow, SCREEN_FLOW_SECTION } from "./screen-flow.renderer.js"
import { sharedScreenIds } from "../../spine/screen-actors.js"
import { flowColumns, layoutScreenFlow } from "./screen-flow-layout.js"
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
/** Cây rẽ 4 nhánh (màn i mở từ màn ⌊(i−2)/4⌋+1): nhiều màn mà ít cột. */
const fanFlows = (s: Spine): void => {
  s.screens.forEach((x) => (x.flow_to = []))
  s.screens.forEach((x, i) => i > 0 && s.screens[Math.floor((i - 1) / 4)].flow_to.push({ to: x.id }))
}
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

describe("screen_flow - một hình cho cả hệ thống, ký pháp template FPT", () => {
  it("fixture: đúng một hình svg cho mọi màn, tiêu đề Screens flow, issues rỗng", () => {
    const parts = renderKind(FIXTURE, "screen_flow")
    expect(parts).toHaveLength(1)
    const [part] = parts
    expect(part).toMatchObject({ format: "svg", section: SCREEN_FLOW_SECTION, owner_id: null, owner_kind: null })
    expect(svgTitleOf(part.source)).toBe("Screens flow")
    expect(part.issues).toEqual([])
    const [only] = partitionScreenFlow(FIXTURE)
    expect(only.diagram.nodes.map((n) => n.id).sort()).toEqual(FIXTURE.screens.map((s) => s.id).sort())
  })

  it("mỗi flow_to tiến là một đường (cả cạnh giữa hai feature); không làn, không initial / final / nhãn", () => {
    const [scene] = sceneOf(FIXTURE)
    // S01 → S05 / S14 (sang feature khác) giờ được vẽ
    expect(ids(scene, "flow:")).toEqual(expect.arrayContaining(["flow:S01>S05", "flow:S01>S14"]))
    for (const id of ids(scene, "flow:")) {
      const [from, to] = id.slice(5).split(">")
      expect(FIXTURE.screens.find((s) => s.id === from)!.flow_to.map((e) => e.to)).toContain(to)
    }
    expect(scene.elements.some((e) => /^(lane|initial|final|start|end|decision|decide):/.test(e.id) || e.id.includes("#label"))).toBe(false)
  })

  it("pop-up = ô-van, màn nhiều tab = khung chứa các hộp tab chữ nghiêng; không stereotype pop-up", () => {
    const svg = renderKind(FIXTURE, "screen_flow")[0].source
    expect(svg).toContain("<ellipse")
    expect(svg).toContain(`font-style="italic"`)
    expect(svg).not.toContain("&lt;&lt;pop-up&gt;&gt;")
  })

  it("màn dùng chung nền #7ACFF5, màn còn lại nền trắng", () => {
    const [{ diagram }] = partitionScreenFlow(FIXTURE)
    const shared = sharedScreenIds(FIXTURE)
    for (const n of diagram.nodes) expect(n.shared).toBe(shared.has(n.id))
    const scene = layoutScreenFlow(diagram)
    for (const n of diagram.nodes) expect(scene.find(n.id)).toMatchObject({ fill: n.shared ? "#7ACFF5" : "#fff" })
  })

  it("màn chưa có actor người nào vẫn được vẽ (không thành gốc trơ trọi cho màn con); chưa có liên kết ⇒ mọi màn nền trắng", () => {
    const orphan = chain(3, (s) => s.screens.push(screen(4)))
    expect(partitionScreenFlow(orphan)[0].diagram.nodes.map((n) => n.id)).toEqual(["S001", "S002", "S003", "S004"])

    const unlinked = chain(3, (s) => (s.use_cases = []))
    const [single] = partitionScreenFlow(unlinked)
    expect(single.diagram.nodes).toHaveLength(3)
    expect(single.diagram.nodes.every((n) => !n.shared)).toBe(true)
    expect(checkScene(layoutScreenFlow(single.diagram), { allowBends: true })).toEqual([])
  })

  it(`≤ ${MAX_SCREENS_PER_DIAGRAM} màn ⇒ một hình kể cả nhiều feature`, () => {
    const spine = chain(MAX_SCREENS_PER_DIAGRAM, (s) => {
      s.features = [{ id: "F1", name: "One", order: 0 }, { id: "F2", name: "Two", order: 1 }]
      s.screens.slice(20).forEach((x) => (x.feature_id = "F2"))
      fanFlows(s)
    })
    expect(partitionScreenFlow(spine)).toHaveLength(1)
  })

  it(`> ${MAX_SCREENS_PER_DIAGRAM} màn ⇒ tách theo feature nguyên vẹn, tiêu đề (i/n), mọi màn có mặt, màn cha ở hình khác đi kèm (không mồ côi), issues rỗng`, () => {
    const spine = chain(60, (s) => {
      s.features = [{ id: "F1", name: "One", order: 0 }, { id: "F2", name: "Two", order: 1 }, { id: "F3", name: "Three", order: 2 }]
      s.screens.forEach((x, i) => (x.feature_id = i < 25 ? "F1" : i < 45 ? "F2" : "F3"))
      fanFlows(s)
    })
    const parts = partitionScreenFlow(spine)
    expect(parts.map((p) => p.title)).toEqual(["Screens flow (1/2)", "Screens flow (2/2)"])
    const featureOf = new Map(spine.screens.map((s) => [s.id, s.feature_id]))
    expect([...new Set(parts[0].diagram.nodes.map((n) => featureOf.get(n.id)))]).toEqual(["F1"])
    // hình 2: mọi màn F2 / F3, cộng đúng các màn F1 nằm trên đường từ màn vào tới chúng ⇒ không màn nào mất cha
    const second = parts[1].diagram
    expect(second.nodes.filter((n) => featureOf.get(n.id) !== "F1").map((n) => n.id)).toEqual(spine.screens.slice(25).map((s) => s.id))
    const parentOf = (id: string) => spine.screens.find((s) => s.flow_to.some((e) => e.to === id))?.id
    for (const n of second.nodes) if (n.id !== "S001") expect(second.nodes.map((m) => m.id)).toContain(parentOf(n.id))
    expect(second.nodes.filter((n) => featureOf.get(n.id) === "F1").every((n) => second.edges.some(([from]) => from === n.id))).toBe(true)
    expect(new Set(parts.flatMap((p) => p.diagram.nodes.map((n) => n.id)))).toEqual(new Set(spine.screens.map((s) => s.id)))
    for (const p of renderKind(spine, "screen_flow")) expect(p.issues).toEqual([])
  })

  it("một feature quá ngưỡng ⇒ tách đôi theo hạng, mỗi phần ≤ ngưỡng", () => {
    const spine = chain(90)
    const parts = partitionScreenFlow(spine)
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.every((p) => p.diagram.nodes.length <= MAX_SCREENS_PER_DIAGRAM)).toBe(true)
    expect(new Set(parts.flatMap((p) => p.diagram.nodes.map((n) => n.id)))).toEqual(new Set(spine.screens.map((s) => s.id)))
  })

  it(`quá ${MAX_COLUMNS} cột ⇒ tách, mỗi hình ≤ ${MAX_COLUMNS} cột`, () => {
    const spine = chain(MAX_COLUMNS + 4)
    const parts = partitionScreenFlow(spine)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(flowColumns(p.diagram)).toBeLessThanOrEqual(MAX_COLUMNS)
    expect(new Set(parts.flatMap((p) => p.diagram.nodes.map((n) => n.id)))).toEqual(new Set(spine.screens.map((s) => s.id)))
  })

  it("không vừa một hình ⇒ mỗi actor người một hình (tiêu đề tên actor), màn dùng chung có mặt ở mọi hình; màn chưa có actor vào Other screens", () => {
    // S001 = đăng nhập (cả hai actor), 25 màn của Founder, 20 màn của Administrator, 1 màn chưa nối actor ⇒ 47 màn
    const spine = chain(47, (s) => {
      fanFlows(s)
      const ucOf = (actor: string, from: number, to: number) => ({
        id: `UC-${actor}`, name: actor, actor_ids: [actor], description: "", includes: [], extends: [],
        function_ids: s.functions.filter((_, i) => i === 0 || (i >= from && i < to)).map((f) => f.id)
      })
      s.use_cases = [ucOf("A01", 1, 26), ucOf("A03", 26, 46)]
      s.functions = s.functions.filter((_, i) => i < 46)
    })
    const parts = partitionScreenFlow(spine)
    expect(parts.map((p) => p.title)).toEqual(["Screens flow (Founder)", "Screens flow (Administrator)", "Screens flow (Other screens)"])
    const [founder, admin, other] = parts.map((p) => p.diagram.nodes.map((n) => n.id))
    expect(founder).toContain("S001")
    expect(admin).toContain("S001")
    for (const id of spine.screens.slice(1, 26).map((s) => s.id)) expect(founder).toContain(id)
    for (const id of spine.screens.slice(26, 46).map((s) => s.id)) expect(admin).toContain(id)
    // màn cha của màn Administrator nằm ở phần Founder (cây rẽ 4 nhánh) ⇒ đi kèm, không màn nào mồ côi
    expect(admin.length).toBeGreaterThan(21)
    // màn chưa có actor kèm đường từ màn vào tới nó
    expect(other).toEqual(["S001", "S003", "S012", "S047"])
    expect(partitionScreenFlow(spine, DIAGRAM_LABELS.vi).map((p) => p.title)).toEqual(["Luồng màn hình (Founder)", "Luồng màn hình (Administrator)", "Luồng màn hình (Màn khác)"])
    for (const p of renderKind(spine, "screen_flow")) expect(p.issues).toEqual([])
  })

  it("tên màn rất dài, nhiều tab, pop-up tên dài: không tràn, issues rỗng", () => {
    const spine = chain(6, (s) => {
      s.screens[1].name = "A ridiculously long screen name that keeps going and going well past any sensible width"
      s.screens[2].name = "Unbrokenwordthatisfarlongerthanthenodewidthcanholdwithoutwrappinganywhere"
      s.screens[3].tabs = ["Overview", "Members and permissions", "Billing", "Audit trail", "Danger zone"]
      s.screens[4].is_popup = true
      s.screens[4].name = "A pop-up with a long name that needs wrapping"
    })
    expect(renderKind(spine, "screen_flow")[0].issues).toEqual([])
  })

  it("cạnh quay lại và trỏ qua lại không vẽ hai chiều; đồ thị có vòng vẫn sạch", () => {
    const spine = chain(5, (s) => {
      s.screens[4].flow_to = [{ to: "S001" }, { to: "S003" }]
      s.screens[2].flow_to.push({ to: "S002" }, { to: "S005" }, { to: "S001" })
    })
    const [scene] = sceneOf(spine)
    // chỉ vẽ cây: S005 mở từ S003 (nông nhất) nên S004 → S005 không vẽ
    expect(ids(scene, "flow:").sort()).toEqual(["flow:S001>S002", "flow:S002>S003", "flow:S003>S004", "flow:S003>S005"])
    expect(checkScene(scene, { allowBends: true })).toEqual([])
  })

  it("trigger / guard không vẽ: đổi chúng không đổi hình", () => {
    const spine = chain(3, (s) => (s.screens[0].flow_to = [{ to: "S002", trigger: "Submit", guard: "OTP valid" }]))
    const changed = structuredClone(spine)
    changed.screens[0].flow_to[0] = { to: "S002", trigger: "Click", guard: "Admin" }
    expect(renderKind(changed, "screen_flow")[0].source).toBe(renderKind(spine, "screen_flow")[0].source)
    expect(renderKind(spine, "screen_flow")[0].source).not.toContain("OTP valid")
  })

  it("không có màn ⇒ không có hình; renderer thuần (cùng Spine ⇒ cùng nguồn)", () => {
    expect(renderKind(mutate((s) => (s.screens = [])), "screen_flow")).toEqual([])
    expect(renderKind(FIXTURE, "screen_flow").map((p) => p.source)).toEqual(renderKind(FIXTURE, "screen_flow").map((p) => p.source))
  })

  it("nhãn tiếng Việt: tiêu đề Luồng màn hình", () => {
    expect(partitionScreenFlow(FIXTURE, DIAGRAM_LABELS.vi)[0].title).toBe("Luồng màn hình")
  })
})
