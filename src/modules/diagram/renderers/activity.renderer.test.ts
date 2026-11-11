import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { spineSchema } from "../../spine/spine.schema.js"
import type { ActivityFlow, ActivityNode, ActivityNodeKind, Spine } from "../../spine/spine.types.js"
import { activityInput, renderActivity } from "./activity.renderer.js"
import { layoutActivity, planActivity, type ActivityLayoutInput } from "./activity-layout.js"
import { svgTitleOf } from "./common.js"
import { renderKind } from "./index.js"
import { DIAGRAM_LABELS } from "./labels.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const withActivity = (ucId: string, nodes: ActivityNode[], flows: ActivityFlow[]): Spine => ({
  ...BASE,
  use_cases: BASE.use_cases.map((u) => (u.id === ucId ? { ...u, activity_nodes: nodes, activity_flows: flows } : { ...u, activity_nodes: undefined, activity_flows: undefined }))
})

const UC = "UC02"
const UC_NAME = BASE.use_cases.find((u) => u.id === UC)!.name
const FEATURE = BASE.functions.find((f) => f.id === BASE.use_cases.find((u) => u.id === UC)!.function_ids[0])!.feature_id
const HUMAN = BASE.actors.find((a) => a.kind === "human")!

/** Đăng nhập: nhập → kiểm tra → sai thì nhập lại (vòng lặp), đúng thì vào trang chủ; hai làn (actor, system). */
const LOGIN_NODES: ActivityNode[] = [
  { id: "N1", kind: "initial" },
  { id: "N2", kind: "action", name: "Enter email and password", lane: HUMAN.id },
  { id: "N3", kind: "action", name: "Validate credentials", lane: "system" },
  { id: "N4", kind: "decision", name: "Credentials valid?" },
  { id: "N5", kind: "action", name: "Show error message", lane: "system" },
  { id: "N6", kind: "action", name: "Open home page", lane: "system" },
  { id: "N7", kind: "final" }
]
const LOGIN_FLOWS: ActivityFlow[] = [
  { from: "N1", to: "N2" },
  { from: "N2", to: "N3" },
  { from: "N3", to: "N4" },
  { from: "N4", to: "N5", guard: "invalid" },
  { from: "N4", to: "N6", guard: "valid" },
  { from: "N5", to: "N2" },
  { from: "N6", to: "N7" }
]

describe("planActivity", () => {
  it("cạnh quay lại nút đang mở là vòng lặp; hạng tăng dọc cạnh tiến", () => {
    const plan = planActivity(["N1", "N2", "N3"], new Set(["N1"]), [["N1", "N2"], ["N2", "N3"], ["N3", "N2"]])
    expect(plan.back).toEqual([["N3", "N2"]])
    expect(plan.forward).toEqual([["N1", "N2"], ["N2", "N3"]])
    expect([...plan.rank]).toEqual(expect.arrayContaining([["N1", 0], ["N2", 1], ["N3", 2]]))
  })
})

describe("activityInput", () => {
  it("làn theo thứ tự xuất hiện; nút không ghi làn kế thừa nút trước; `system` thành nhãn System", () => {
    const spine = withActivity(UC, LOGIN_NODES, LOGIN_FLOWS)
    const input = activityInput(spine, spine.use_cases.find((u) => u.id === UC)!, DIAGRAM_LABELS.en)
    expect(input.lanes.map((l) => l.name)).toEqual([HUMAN.name, DIAGRAM_LABELS.en.system])
    const laneOf = (id: string) => input.lanes[input.nodes.find((n) => n.id === id)!.lane].id
    expect(laneOf("N1")).toBe(HUMAN.id)
    expect(laneOf("N4")).toBe("system")
    expect(laneOf("N7")).toBe("system")
  })
})

describe("renderActivity — mỗi use case có luồng xử lý một hình (phần chức năng)", () => {
  it("chỉ use case có activity_nodes; chủ = use case, section = tính năng chứa use case; tiêu đề; bố cục hợp lệ", () => {
    const parts = renderActivity(withActivity(UC, LOGIN_NODES, LOGIN_FLOWS))
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ kind: "activity", format: "svg", owner_kind: "use_case", owner_id: UC, section: `feature:${FEATURE}` })
    expect(svgTitleOf(parts[0].source)).toBe(`Activity Diagram — ${UC_NAME}`)
    expect(parts[0].issues).toEqual([])
    expect(parts[0].source).toContain("[invalid]")
    expect(parts[0].source).toContain("Credentials valid?")
  })

  it("không function nào có nút ⇒ không có hình; renderKind ghi source_hash", () => {
    expect(renderActivity(withActivity(UC, [], []))).toEqual([])
    const parts = renderKind(withActivity(UC, LOGIN_NODES, LOGIN_FLOWS), "activity")
    expect(parts[0].source_hash).toMatch(/\w+/)
  })

  it("use case chưa thuộc tính năng nào ⇒ hình ở mục đặc tả use case (fixed:2.2.2)", () => {
    const spine = withActivity(UC, LOGIN_NODES, LOGIN_FLOWS)
    const orphan: Spine = { ...spine, use_cases: spine.use_cases.map((u) => (u.id === UC ? { ...u, function_ids: [] } : u)) }
    expect(renderActivity(orphan)[0].section).toBe("fixed:2.2.2")
  })

  it("fork / join, nhiều nhánh vào một final, flow trỏ nút không có thật bị bỏ", () => {
    const nodes: ActivityNode[] = [
      { id: "A1", kind: "initial" },
      { id: "A2", kind: "action", name: "Submit order" },
      { id: "A3", kind: "fork" },
      { id: "A4", kind: "action", name: "Charge card" },
      { id: "A5", kind: "action", name: "Reserve stock" },
      { id: "A6", kind: "join" },
      { id: "A7", kind: "decision" },
      { id: "A8", kind: "action", name: "Send confirmation email to the customer with a very long description that must wrap" },
      { id: "A9", kind: "final" }
    ]
    const flows: ActivityFlow[] = [
      { from: "A1", to: "A2" },
      { from: "A2", to: "A3" },
      { from: "A3", to: "A4" },
      { from: "A3", to: "A5" },
      { from: "A4", to: "A6" },
      { from: "A5", to: "A6" },
      { from: "A6", to: "A7" },
      { from: "A7", to: "A8", guard: "paid" },
      { from: "A7", to: "A9", guard: "payment failed" },
      { from: "A8", to: "A9" },
      { from: "A8", to: "ZZ" }
    ]
    const [part] = renderActivity(withActivity(UC, nodes, flows))
    expect(part.issues).toEqual([])
    expect(part.source).not.toContain("ZZ")
  })
})

describe("layoutActivity — đồ thị ngẫu nhiên luôn qua checkScene", () => {
  const KINDS: ActivityNodeKind[] = ["action", "action", "action", "decision", "merge", "fork", "join", "final"]
  /** PRNG tất định (mulberry32). */
  const rng = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  for (let seed = 1; seed <= 60; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed)
      const n = 3 + Math.floor(r() * 12)
      const laneCount = Math.floor(r() * 4)
      const nodes = Array.from({ length: n }, (_, i) => {
        const kind: ActivityNodeKind = i === 0 ? "initial" : KINDS[Math.floor(r() * KINDS.length)]
        return { id: `N${i}`, kind, name: kind === "action" || (kind === "decision" && r() < 0.5) ? `Step ${i} ${"word ".repeat(Math.floor(r() * 6))}`.trim() : "", lane: laneCount === 0 ? 0 : Math.floor(r() * laneCount) }
      })
      const flows: ActivityLayoutInput["flows"][number][] = []
      for (let i = 1; i < n; i++) flows.push({ from: `N${Math.floor(r() * i)}`, to: `N${i}`, guard: r() < 0.3 ? `cond ${i}` : "" })
      const extra = Math.floor(r() * n)
      for (let k = 0; k < extra; k++) flows.push({ from: `N${Math.floor(r() * n)}`, to: `N${Math.floor(r() * n)}`, guard: r() < 0.3 ? `back ${k}` : "" })
      const lanes = Array.from({ length: laneCount }, (_, i) => ({ id: `L${i}`, name: `Lane ${i}` }))
      const issues = checkScene(layoutActivity({ lanes, nodes, flows }), { allowBends: true })
      expect(issues.map((i) => i.message)).toEqual([])
    })
  }
})
