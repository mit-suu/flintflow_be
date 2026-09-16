import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import { INVARIANTS, REQUIRED_FIXED_SECTIONS, checkInvariants } from "./invariants.js"
import { createEmptySpine } from "./spine.repository.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const variant = (mutate: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  mutate(s)
  return s
}

const rulesOf = (after: Spine, before: Spine = FIXTURE) => checkInvariants(after, before).map((v) => v.rule)

describe("invariants", () => {
  it("có đúng 8 bất biến, fixture không vi phạm", () => {
    expect(INVARIANTS.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(checkInvariants(FIXTURE, FIXTURE)).toEqual([])
    expect(REQUIRED_FIXED_SECTIONS).not.toContain("fixed:4.2.4")
    expect(REQUIRED_FIXED_SECTIONS).not.toContain("fixed:I")
  })

  it("1 — xoá section bắt buộc; xoá section tuỳ chọn 4.2.4 thì được", () => {
    expect(rulesOf(variant((s) => (s.sections = s.sections.filter((x) => x.id !== "fixed:5.2"))))).toContain(
      "invariant_1_required_section"
    )
    expect(rulesOf(variant((s) => (s.sections = s.sections.filter((x) => !x.id.startsWith("feature:")))))).toContain(
      "invariant_1_required_section"
    )
    expect(rulesOf(variant((s) => (s.sections = s.sections.filter((x) => x.id !== "fixed:4.2.4"))))).toEqual([])
  })

  it("2 — xoá phần tử human cuối cùng; Spine rỗng không vi phạm", () => {
    expect(rulesOf(variant((s) => (s.actors = s.actors.filter((a) => a.kind !== "human"))))).toContain("invariant_2_last_element")
    const empty = createEmptySpine()
    expect(checkInvariants(empty, empty)).toEqual([])
  })

  it("3 — chỉ báo khoá chết MỚI", () => {
    const broken = variant((s) => (s.screens[0].flow_to = [...s.screens[0].flow_to, "S99"]))
    expect(rulesOf(broken)).toEqual(["invariant_3_dead_reference"])
    // lỗi đã có từ trước: sửa chỗ khác vẫn được
    const stillBroken = structuredClone(broken)
    stillBroken.actors[0].name = "Renamed"
    expect(checkInvariants(stillBroken, broken)).toEqual([])
  })

  it("4 — function trỏ màn không tồn tại", () => {
    expect(rulesOf(variant((s) => (s.functions[0].screen_id = "S99")))).toContain("invariant_4_screen_missing")
  })

  it("5 — feature order hở / function order trùng; function order hở thì được", () => {
    expect(rulesOf(variant((s) => (s.features[5].order = 9)))).toContain("invariant_5_feature_order")
    expect(rulesOf(variant((s) => (s.functions[1].order = s.functions[0].order)))).toContain("invariant_5_function_order")
    expect(rulesOf(variant((s) => (s.functions[3].order = 40)))).toEqual([])
  })

  it("6 — function lệch feature của màn", () => {
    expect(rulesOf(variant((s) => (s.functions[0].feature_id = "F2")))).toContain("invariant_6_feature_mismatch")
  })

  it("8 — xoá màn cursor; thêm màn trong S-5 phải pending và vào queue", () => {
    expect(rulesOf(variant((s) => (s.screens = s.screens.filter((x) => x.id !== "S10"))))).toContain("invariant_8_cursor_screen")

    const inS5 = variant((s) => (s.progress.current_phase = "S-5"))
    const added = structuredClone(inS5)
    added.screens.push({ ...added.screens[0], id: "S20", flow_to: [], detail_status: "signed_off" })
    expect(checkInvariants(added, inS5).map((v) => v.rule)).toEqual(
      expect.arrayContaining(["invariant_8_screen_not_pending", "invariant_8_screen_not_queued"])
    )
    added.screens[added.screens.length - 1].detail_status = "pending"
    added.progress.screen_queue.push("S20")
    expect(checkInvariants(added, inS5)).toEqual([])
  })
})
