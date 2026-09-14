import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import { CASCADE_POLICY, RemovedIds, planCascade, planFeatureRenumber, planScreenQueueAppend } from "./cascade.js"
import { REFERENCE_FIELDS } from "./reference-fields.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const removeScreen = (id: string) => {
  const spine = structuredClone(FIXTURE)
  const removed = new RemovedIds()
  const screen = spine.screens.find((s) => s.id === id)
  spine.screens = spine.screens.filter((s) => s.id !== id)
  removed.trackElement("screens", screen)
  return { spine, removed }
}

describe("cascade", () => {
  it("CASCADE_POLICY phủ đúng mọi reference field", () => {
    expect(Object.keys(CASCADE_POLICY).sort()).toEqual(REFERENCE_FIELDS.map((f) => f.path).sort())
  })

  it("vòng đầu khi xoá S08: functions, permissions, flow_to (không đụng khoá chết có sẵn)", () => {
    const { spine, removed } = removeScreen("S08")
    const plan = planCascade(spine, removed)
    const paths = plan.ops.map((o) => o.path)
    expect(paths).toEqual(
      expect.arrayContaining(["functions[id=FN034]", "screens[id=S07].flow_to[=S08]", "permissions[id=" + FIXTURE.permissions.find((p) => p.screen_id === "S08")?.id + "]"])
    )
    expect(plan.ops.filter((o) => o.path.startsWith("functions[")).every((o) => o.op === "remove")).toBe(true)
    expect(plan.referrers).toEqual([])

    // khoá chết không do xoá trong lô ⇒ không dọn hộ
    const untouched = planCascade(spine, new RemovedIds())
    expect(untouched.ops).toEqual([])
  })

  it("trackElement function ghi nhận cả validations", () => {
    const removed = new RemovedIds()
    removed.trackElement("functions", FIXTURE.functions.find((f) => f.id === "FN029"))
    expect(removed.has("functions", "FN029")).toBe(true)
    expect(removed.has("validations", "FN029-V1")).toBe(true)
  })

  it("restrict: xoá feature còn màn ⇒ referrers, không op", () => {
    const spine = structuredClone(FIXTURE)
    spine.features = spine.features.filter((f) => f.id !== "F1")
    const removed = new RemovedIds()
    removed.add("features", "F1")
    const plan = planCascade(spine, removed)
    expect(plan.referrers.map((r) => r.path)).toEqual(expect.arrayContaining(["screens[id=S01].feature_id", "functions[id=FN001].feature_id"]))
    expect(plan.ops.map((o) => o.path)).toEqual(["sections[id=feature:F1]"])
  })

  it("renumber feature chỉ khi có feature bị xoá trong lô", () => {
    const spine = structuredClone(FIXTURE)
    spine.features = spine.features.filter((f) => f.id !== "F2")
    expect(planFeatureRenumber(spine, new RemovedIds())).toEqual([])
    const removed = new RemovedIds()
    removed.add("features", "F2")
    expect(planFeatureRenumber(spine, removed).map((o) => [o.path, o.value])).toEqual([
      ["features[id=F3].order", 1],
      ["features[id=F4].order", 2],
      ["features[id=F5].order", 3],
      ["features[id=F6].order", 4]
    ])
  })

  it("append screen_queue chỉ trong S-5 và chỉ cho màn mới", () => {
    const before = structuredClone(FIXTURE)
    const after = structuredClone(FIXTURE)
    after.screens.push({ ...after.screens[0], id: "S20", flow_to: [], detail_status: "pending" })
    expect(planScreenQueueAppend(after, before)).toEqual([])
    after.progress.current_phase = "S-5"
    expect(planScreenQueueAppend(after, before)).toMatchObject([{ op: "add", path: "progress.screen_queue[]", value: "S20" }])
  })
})
