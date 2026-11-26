import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import { REQUIRED_FIXED_SECTION_IDS } from "../spine/section-registry.js"
import type { LayoutEntry } from "./template-profile.model.js"
import { compareTargetStructure } from "./target-structure.js"
import { draftOutOfScope, isOutOfScopeHeading, outOfScopeSectionIds } from "./out-of-scope.js"

const entry = (order: number, section_id: string, heading_text: string, level = 1): LayoutEntry => ({ order, section_id, heading_text, level })
const spine = createEmptySpine({ name: "Thư viện" })
const ct = (in_scope: boolean, confidence = 0.9) => ({ block_id: "B1", iso29148: "x", in_scope, confidence })

describe("isOutOfScopeHeading (mục trống xét theo heading)", () => {
  it("dự toán, chi phí, ngân sách, báo giá (có số mục) ⇒ ngoài SRS", () => {
    for (const h of ["6 Dự toán kinh phí", "Phụ lục A Dự toán", "4.2 Chi phí dự kiến", "Budget", "Cost Estimate", "Ngân sách dự án", "Báo giá"]) expect(isOutOfScopeHeading(h), h).toBe(true)
  })
  it("heading thường của SRS hoặc không rõ loại ⇒ không đoán", () => {
    // FLF-455: heading thường chứa chữ "chi phí" / "pricing" không bị bắt; chữ tổ hợp NFC / NFD đều khớp
    for (const h of ["Quản lý chi phí", "Chi phí vận hành", "Pricing rules", "Budgetary controls", "Cost-aware routing"]) expect(isOutOfScopeHeading(h), h).toBe(false)
    expect(isOutOfScopeHeading("Dự toán chi phí".normalize("NFD"))).toBe(true)
    for (const h of ["Ghi chú nhóm", "Open Issues", "Product Overview", "Rủi ro đã biết", ""]) expect(isOutOfScopeHeading(h), h).toBe(false)
  })
})

describe("draftOutOfScope (mục có chữ, I-4 phân loại theo nội dung)", () => {
  it("mọi khối ngoài 29148 và AI không rút phần tử nào ⇒ ngoài phạm vi", () => {
    expect(draftOutOfScope({ fields: [], content_types: [ct(false), ct(false)] })).toBe(true)
  })
  it("có khối thuộc SRS, hoặc AI vẫn rút được phần tử ⇒ ở lại trong phạm vi", () => {
    expect(draftOutOfScope({ fields: [], content_types: [ct(false), ct(true)] })).toBe(false)
    expect(draftOutOfScope({ fields: [{ path: "actors[id=A1].name", value: "x", confidence: 0.9, source_block_ids: [], confirmed: true } as never], content_types: [ct(false)] })).toBe(false)
  })
  it("không phân loại, hoặc độ tin dưới ngưỡng ⇒ không kết luận ngoài phạm vi", () => {
    expect(draftOutOfScope({ fields: [], content_types: [] })).toBe(false)
    expect(draftOutOfScope({ fields: [], content_types: [ct(false, 0.3)] })).toBe(false)
  })
})

describe("outOfScopeSectionIds", () => {
  it("đổi sang id của layout, chỉ giữ mục riêng của file", () => {
    const drafts = [
      { section_id: "content:@B5", fields: [], content_types: [ct(false)] },
      { section_id: "fixed:2.1", fields: [], content_types: [ct(false)] },
      { section_id: "content:@B9", fields: [], content_types: [ct(true)] }
    ]
    const ids = outOfScopeSectionIds(drafts, (id) => (id === "content:@B5" ? "custom:CS01" : id === "content:@B9" ? "custom:CS02" : id))
    expect([...ids]).toEqual(["custom:CS01"])
  })
})

describe("FLF-455 - Ngoài phạm vi trong so cấu trúc đích, mọi chế độ", () => {
  const layout = [entry(0, "fixed:1", "1 Overview"), entry(1, "fixed:2.1", "2.1 Actors", 2), entry(2, "custom:CS01", "3 Kế hoạch tài chính"), entry(3, "custom:CS02", "4 Dự toán kinh phí"), entry(4, "custom:CS03", "5 Ghi chú")]
  const statuses = (r: ReturnType<typeof compareTargetStructure>) => Object.fromEntries(r.sections.filter((s) => s.section_id.startsWith("custom:")).map((s) => [s.section_id, s.status]))

  it("chế độ 3: mục AI xếp ngoài 29148 và mục trống heading dự toán ⇒ ngoài phạm vi, không vào danh sách thiếu; heading riêng khác trống vẫn là mục của mẫu", () => {
    const r = compareTargetStructure(layout, new Set(["fixed:1", "custom:CS01"]), spine, "fixed", undefined, { outOfScope: new Set(["custom:CS01"]) })
    expect(statuses(r)).toEqual({ "custom:CS01": "out_of_scope", "custom:CS02": "out_of_scope", "custom:CS03": "missing" })
    expect(r.resolved_mode).toBe(3)
    expect(r.missing).toEqual(["fixed:2.1", "custom:CS03"])
  })

  it("chế độ 1: file đủ mục, mục dự toán ngoài phạm vi không làm file thành thiếu", () => {
    const r = compareTargetStructure(layout.slice(0, 4), new Set(["fixed:1", "fixed:2.1", "custom:CS01"]), spine, "fixed", undefined, { outOfScope: new Set(["custom:CS01"]) })
    expect(r.resolved_mode).toBe(1)
    expect(r.missing).toEqual([])
    expect(statuses(r)).toEqual({ "custom:CS01": "out_of_scope", "custom:CS02": "out_of_scope" })
  })

  it("chế độ 4: bổ sung theo mẫu chuẩn thêm mục thiếu của mẫu chuẩn, mục ngoài phạm vi giữ nguyên trạng thái và không bị thêm vào", () => {
    const r = compareTargetStructure(layout, new Set(["fixed:1", "custom:CS01"]), spine, "free", undefined, { outOfScope: new Set(["custom:CS01"]) })
    expect(r.resolved_mode).toBe(4)
    expect(statuses(r)["custom:CS01"]).toBe("out_of_scope")
    expect(r.missing.some((id) => id.startsWith("custom:CS0") && id !== "custom:CS03")).toBe(false)
    for (const id of REQUIRED_FIXED_SECTION_IDS) if (id !== "fixed:1") expect(r.sections.some((s) => s.section_id === id)).toBe(true)
  })

  it("sửa section khác không làm đổi section ngoài phạm vi (có thêm nội dung cho Actors, mục dự toán vẫn ngoài phạm vi và các mục khác không đổi)", () => {
    const opts = { outOfScope: new Set(["custom:CS01"]) }
    const a = compareTargetStructure(layout, new Set(["fixed:1", "custom:CS01"]), spine, "fixed", "t", opts)
    const b = compareTargetStructure(layout, new Set(["fixed:1", "fixed:2.1", "custom:CS01", "custom:CS03"]), spine, "fixed", "t", opts)
    const out = (r: typeof a) => r.sections.filter((s) => s.status === "out_of_scope")
    expect(out(b)).toEqual(out(a))
    expect(b.sections.find((s) => s.section_id === "fixed:2.1")?.status).toBe("present")
  })

  it("mục dự toán đã viết thành phần của SRS (có chữ, không bị AI xếp ngoài phạm vi) vẫn là có", () => {
    const r = compareTargetStructure(layout, new Set(["fixed:1", "custom:CS02"]), spine, "fixed")
    expect(r.sections.find((s) => s.section_id === "custom:CS02")?.status).toBe("present")
  })
})
