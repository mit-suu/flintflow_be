import { describe, expect, it } from "vitest"
import { applyPairEdits, pairSections, type NewHeading, type OldHeading } from "./pair-sections.js"
import { isOpenState, stateUpdate, MIGRATION_STATES } from "./template-migration.model.js"
import { startFromFileSchema } from "./template-migration.dto.js"

const old = (key: string, heading_text: string, level: number, section_id = key): OldHeading => ({ key, heading_text, level, section_id })
const neu = (index: number, heading_text: string, section_id: string, extra: Partial<NewHeading> = {}): NewHeading => ({ key: `n${index}`, heading_text, section_id, ...extra })

describe("pairSections — trường hợp biên", () => {
  it("hai heading cũ cùng section_id không cùng ghép vào một heading mới; sửa cặp không liên quan vẫn được", () => {
    const oldDoc = [old("fixed:5.1", "5.1 Business Rules", 2), old("fixed:5.1#2", "Business Rules (tiếp)", 2, "fixed:5.1"), old("fixed:1", "1 Overview", 1)]
    const newDoc = [neu(0, "5.1 Business Rules", "fixed:5.1"), neu(1, "1 Intro", "fixed:1")]
    const r = pairSections(oldDoc, newDoc)
    expect(r.pairs.filter((p) => p.new_key === "n0").map((p) => p.old_key)).toEqual(["fixed:5.1"])
    expect(r.pairs.find((p) => p.old_key === "fixed:5.1#2")!.new_key).toBeNull()
    expect(() => applyPairEdits(r, newDoc, [{ old_key: "fixed:1", new_key: null }])).not.toThrow()
  })

  it("mục khung có chữ trùng tên một phần tử trong Spine vẫn là mục khung", () => {
    const r = pairSections([old("fixed:2.1", "2.1 Login", 2)], [neu(0, "2.1 Actors", "fixed:2.1")], { elementNames: new Set(["login"]), elementIds: new Set(["LOGIN"]) })
    expect(r.followers).toEqual([])
    expect(r.pairs).toMatchObject([{ old_key: "fixed:2.1", new_key: "n0" }])
  })

  it("heading ví dụ của mẫu đích lồng dưới mục chứa phần tử bị bỏ qua, không thành mục thiếu", () => {
    const r = pairSections(
      [old("fixed:2.2.2", "2.2.2 Descriptions", 3)],
      [neu(0, "2.2.2 Descriptions", "fixed:2.2.2", { level: 3 }), neu(1, "UC01 Login example", "unmapped", { level: 4 }), neu(2, "2.3 Notes", "unmapped", { level: 2 })]
    )
    expect(r.ignored_new).toEqual(["n1"])
  })

  it("không biết cấp heading của mẫu đích ⇒ không áp luật lồng (không bỏ nhầm)", () => {
    const r = pairSections([old("fixed:2.2.2", "2.2.2 Descriptions", 3)], [neu(0, "2.2.2 Descriptions", "fixed:2.2.2"), neu(1, "UC01 Login example", "unmapped")])
    expect(r.ignored_new).toEqual([])
  })

  it("ghép tay một heading đang là lựa chọn của mục bị tách khác ⇒ gỡ khỏi split, split còn ≤ 1 thì bỏ", () => {
    const oldDoc = [old("fixed:4.2.2", "4.2.2 Reliability", 3), old("custom:c1", "Availability notes", 2)]
    const newDoc = [neu(0, "Reliability", "fixed:4.2.2"), neu(1, "Availability", "fixed:4.2.2")]
    const base = pairSections(oldDoc, newDoc)
    expect(base.split).toHaveLength(1)
    const r = applyPairEdits(base, newDoc, [{ old_key: "custom:c1", new_key: "n1" }])
    expect(r.split).toEqual([])
    expect(r.pairs.find((p) => p.old_key === "custom:c1")!.new_key).toBe("n1")
  })
})

describe("stateUpdate", () => {
  it("open luôn suy ra từ trạng thái mới", () => {
    for (const state of MIGRATION_STATES) expect(stateUpdate(state, { x: 1 })).toEqual({ x: 1, state, open: isOpenState(state) })
    expect(stateUpdate("applied").open).toBe(false)
    expect(stateUpdate("failed").open).toBe(false)
    expect(stateUpdate("applying").open).toBe(true)
  })
})

describe("startFromFileSchema", () => {
  it("name / template_id chỉ hợp lệ khi đăng lên thư viện", () => {
    expect(startFromFileSchema.safeParse({ name: "X" }).success).toBe(false)
    expect(startFromFileSchema.safeParse({ publish_to_org: "true", name: "X" }).success).toBe(true)
  })
})
