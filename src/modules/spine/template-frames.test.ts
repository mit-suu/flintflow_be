import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Spine, SpineFunction } from "./spine.types.js"
import { planTransaction } from "./op-engine.js"
import { findDeadReferences } from "./reference-fields.js"
import { hasTemplateFrames, isTemplateFrame, templateFrameOps, withFrameRenumber, type FrameLayoutEntry } from "./template-frames.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MINIMAL: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-minimal.json"), "utf8")))

const fn = (id: string, feature_id: string, order: number, name: string, screen_id: string | null = null): SpineFunction => ({
  id,
  screen_id,
  feature_id,
  order,
  name,
  trigger: "",
  description: name === "<<Function Name>>" ? "" : `Does ${name}.`,
  normal: [],
  abnormal: [],
  validations: [],
  business_rule_ids: [],
  priority: null
})

const LAYOUT: FrameLayoutEntry[] = [
  { section_id: "fixed:3.1", heading_text: "3.1 System Overview" },
  { section_id: "feature:F-3.2", heading_text: "3.2 <<Feature Name 1>>" },
  { section_id: "function:FR-3.2.1", heading_text: "3.2.1 <<Function Name 1>>" },
  { section_id: "function:FR-3.2.2", heading_text: "3.2.2 <<Function Name 2>>" },
  { section_id: "feature:F-3.3", heading_text: "3.3 <<Feature Name 2>>" }
]

/** Report3: 2 khung tính năng (khung 1 có 2 khung chức năng) + `features` thật × `perFeature` chức năng màn mỗi tính năng. */
const build = (features: number, perFeature: number): Spine => {
  const spine = structuredClone(MINIMAL)
  spine.actors = [{ id: "A01", name: "Customer", kind: "human", description: "Buys things." }]
  spine.features = [
    { id: "F-3.2", name: "<<Feature Name 1>>", order: 0 },
    { id: "F-3.3", name: "<<Feature Name 2>>", order: 1 }
  ]
  spine.functions = [fn("FR-3.2.1", "F-3.2", 0, "<<Function Name 1>>"), fn("FR-3.2.2", "F-3.2", 1, "<<Function Name 2>>")]
  spine.screens = []
  spine.use_cases = []
  for (let i = 1; i <= features; i++) {
    spine.features.push({ id: `F${i}`, name: `Real feature ${i}`, order: i + 1 })
    spine.screens.push({
      id: `S${i}`,
      feature_id: `F${i}`,
      name: `Screen ${i}`,
      description: "",
      flow_to: [],
      is_popup: false,
      tabs: [],
      primary_function_id: perFeature ? `FN${i}1` : null,
      queue_order: i,
      detail_status: "pending"
    } as Spine["screens"][number])
    for (let j = 1; j <= perFeature; j++) spine.functions.push(fn(`FN${i}${j}`, `F${i}`, j - 1, `Real function ${i}.${j}`, `S${i}`))
    if (perFeature) {
      spine.use_cases.push({
        id: `UC0${i}`,
        name: `Use feature ${i}`,
        actor_ids: ["A01"],
        function_ids: Array.from({ length: perFeature }, (_, j) => `FN${i}${j + 1}`),
        description: "",
        includes: [],
        extends: []
      } as Spine["use_cases"][number])
    }
  }
  return spineSchema.parse(spine)
}

const apply = (spine: Spine, dropEmptyFunctionFrames = true) => {
  const plan = templateFrameOps(spine, { layout: LAYOUT, dropEmptyFunctionFrames })
  const result = planTransaction(spine, { base_version: spine.spine_version, ops: plan.ops, by: "user-1" }, { startSeq: 1 })
  return { plan, after: result.spine }
}

describe("isTemplateFrame", () => {
  it("tên là chỗ điền của mẫu ⇒ khung; tên thật ⇒ không", () => {
    expect(isTemplateFrame({ name: "<<Feature Name 1>>" })).toBe(true)
    expect(isTemplateFrame({ name: " <<Function Name 2>> " })).toBe(true)
    expect(isTemplateFrame({ name: "Booking" })).toBe(false)
    expect(hasTemplateFrames(build(0, 0))).toBe(true)
  })
})

describe("templateFrameOps", () => {
  it("dự án không khung ⇒ lô rỗng", () => {
    const spine = structuredClone(build(2, 1))
    spine.features = spine.features.filter((f) => !isTemplateFrame(f))
    spine.functions = spine.functions.filter((f) => !isTemplateFrame(f))
    expect(templateFrameOps(spine, { layout: LAYOUT, dropEmptyFunctionFrames: true }).ops).toEqual([])
  })

  for (const features of [0, 1, 2, 3]) {
    for (const perFeature of [0, 1, 3]) {
      it(`${features} tính năng × ${perFeature} chức năng: qua bất biến, không còn khung, idempotent`, () => {
        const { after } = apply(build(features, perFeature))
        expect(findDeadReferences(after)).toEqual([])
        if (features === 0) {
          // Chưa có tính năng thật: bất biến 2 cấm xoá hết ⇒ khung ở lại, in như mục còn trống
          expect(after.features.map((f) => f.id)).toEqual(["F-3.2", "F-3.3"])
          return
        }
        expect(after.features.some(isTemplateFrame)).toBe(false)
        expect(after.features).toHaveLength(features)
        if (perFeature === 0) {
          // Không còn chức năng thật ⇒ giữ một khung chức năng (bất biến 2)
          expect(after.functions.map((f) => f.id)).toEqual(["FR-3.2.1"])
        } else {
          expect(after.functions.some(isTemplateFrame)).toBe(false)
          expect(after.functions).toHaveLength(features * perFeature)
        }
        expect(templateFrameOps(after, { layout: LAYOUT, dropEmptyFunctionFrames: true }).ops).toEqual([])
      })
    }
  }

  it("tính năng thật lấp khung theo thứ tự file, giữ id khung; phần dư giữ id riêng, xếp sau", () => {
    const { after, plan } = apply(build(3, 3))
    const byOrder = [...after.features].sort((a, b) => a.order - b.order)
    expect(byOrder.map((f) => [f.id, f.name])).toEqual([
      ["F-3.2", "Real feature 1"],
      ["F-3.3", "Real feature 2"],
      ["F3", "Real feature 3"]
    ])
    // Chức năng 1, 2 của tính năng 1 vào khung 3.2.1, 3.2.2; chức năng 3 dư ở lại dưới 3.2
    const fns = after.functions.filter((f) => f.feature_id === "F-3.2").sort((a, b) => a.order - b.order)
    expect(fns.map((f) => [f.id, f.name])).toEqual([
      ["FR-3.2.1", "Real function 1.1"],
      ["FR-3.2.2", "Real function 1.2"],
      ["FN13", "Real function 1.3"]
    ])
    expect(after.functions.find((f) => f.id === "FR-3.2.1")?.screen_id).toBe("S1")
    expect(plan.filled).toContainEqual({ kind: "feature", frame: "F-3.2", real: "F1" })
    expect(plan.ops.find((o) => o.path === "features[id=F-3.2].name")?.reason).toBe('Tính năng "Real feature 1" điền vào mục 3.2 của mẫu')
  })

  it("tham chiếu chuyển sang id khung: màn, use case, chức năng chính của màn", () => {
    const { after } = apply(build(2, 2))
    expect(after.screens.find((s) => s.id === "S1")).toMatchObject({ feature_id: "F-3.2", primary_function_id: "FR-3.2.1" })
    expect(after.screens.find((s) => s.id === "S2")).toMatchObject({ feature_id: "F-3.3" })
    expect(after.use_cases.find((u) => u.id === "UC01")?.function_ids).toEqual(["FR-3.2.1", "FR-3.2.2"])
  })

  it("khung tính năng thừa bị xoá cùng khung chức năng của nó", () => {
    const spine = build(1, 1)
    // Khung 3.3 có khung chức năng riêng
    spine.functions.push(fn("FR-3.3.1", "F-3.3", 0, "<<Function Name 1>>"))
    const { after, plan } = apply(spine)
    expect(after.features.map((f) => f.id)).toEqual(["F-3.2"])
    expect(plan.dropped.map((d) => d.id).sort()).toEqual(["F-3.3", "FR-3.2.2", "FR-3.3.1"])
  })

  it("accept S-4.1 giữ khung chức năng còn trống (S-4.4 còn lấp); S-4.4 lấp bằng chức năng không màn", () => {
    const { after } = apply(build(1, 1), false)
    expect(after.functions.find((f) => f.id === "FR-3.2.2")?.name).toBe("<<Function Name 2>>")
    // S-4.4 thêm chức năng không màn cho tính năng đã lấp
    const withNonScreen = spineSchema.parse({ ...after, functions: [...after.functions, fn("FN90", "F-3.2", 0, "Nightly reminder")] })
    const { after: final } = apply(withNonScreen)
    expect(final.functions.find((f) => f.id === "FR-3.2.2")).toMatchObject({ name: "Nightly reminder", screen_id: null, feature_id: "F-3.2" })
    expect(final.functions.some((f) => f.id === "FN90")).toBe(false)
  })

  it("tính năng đã có heading riêng trong file (chế độ 4) không lấp khung", () => {
    const spine = build(2, 0)
    const plan = templateFrameOps(spine, { layout: [...LAYOUT, { section_id: "feature:F1", heading_text: "3.4 Real feature 1" }], dropEmptyFunctionFrames: true })
    expect(plan.filled).toEqual([{ kind: "feature", frame: "F-3.2", real: "F2" }])
  })
})

describe("withFrameRenumber", () => {
  it("lô thêm tính năng khi Spine còn khung ⇒ nối renumber; không khung ⇒ giữ nguyên", () => {
    const add = { op: "add" as const, path: "features[]", value: { id: "F1", name: "Booking", order: 0 } }
    expect(withFrameRenumber(build(0, 0), [add]).slice(-1)[0]).toMatchObject({ op: "renumber", path: "features[]" })
    const plain = build(1, 0)
    plain.features = plain.features.filter((f) => !isTemplateFrame(f))
    expect(withFrameRenumber(plain, [add])).toEqual([add])
  })

  it("model đặt order 0 trùng khung ⇒ lô vẫn qua bất biến", () => {
    const spine = build(0, 0)
    const ops = withFrameRenumber(spine, [{ op: "add", path: "features[]", value: { id: "F1", name: "Booking", order: 0 } }])
    expect(() => planTransaction(spine, { base_version: spine.spine_version, ops, by: "user-1" }, { startSeq: 1 })).not.toThrow()
  })
})
