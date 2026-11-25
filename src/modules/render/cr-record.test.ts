/**
 * FLF-411 (U2-6): mô tả dòng §I của change request theo ngôn ngữ tài liệu.
 */
import { describe, expect, it } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import { crRowDescription, describeCrChanges } from "./cr-record.js"

const spine = {
  actors: [{ id: "A04", name: "Patron" }],
  business_rules: [{ id: "BR-03", statement: "x" }]
} as unknown as Spine

describe("crRowDescription", () => {
  it("FLF-466: liệt kê đủ mã CR của dòng gộp, không trùng, rồi mô tả từ thay đổi", () => {
    const changes = [{ op: "set", path: "project.system_name" }]
    expect(crRowDescription(["CR-012", "CR-013", "CR-012"], changes, "en")).toBe("CR-012, CR-013: Update system name")
    expect(crRowDescription(["CR-012", "CR-013"], changes, "vi")).toBe("CR-012, CR-013: Cập nhật tên hệ thống")
  })

  it("mô tả luôn dựng từ thay đổi, không chép tiêu đề / câu chat của CR, theo ngôn ngữ tài liệu, không mã nội bộ", () => {
    const changes = [
      { op: "set", path: "project.system_name" },
      { op: "remove", path: "actors[id=A04]" },
      { op: "set", path: "business_rules[id=BR-03].statement" },
      { op: "set", path: "business_rules[id=BR-03].tier" }
    ]
    expect(crRowDescription(["CR-001"], changes, "en", spine)).toBe(
      'CR-001: Update system name; Delete actor "Patron"; Update business rule BR-03'
    )
    expect(crRowDescription(["CR-002"], changes.slice(0, 1), "vi", spine)).toBe("CR-002: Cập nhật tên hệ thống")
  })

  it("phần tử không tên, mã nội bộ ⇒ chỉ loại phần tử; quá 3 thay đổi ⇒ ghi số còn lại; không dựng được ⇒ Document updated", () => {
    expect(describeCrChanges([{ op: "add", path: "screens[id=S09]" }], "en")).toBe("Add screen")
    const many = ["UC-01", "UC-02", "UC-03", "UC-04", "UC-05"].map((id) => ({ op: "set", path: `use_cases[id=${id}].description` }))
    expect(describeCrChanges(many, "en")).toBe("Update use case UC-01; Update use case UC-02; Update use case UC-03; and 2 more changes")
    expect(crRowDescription(["CR-003"], [{ op: "set", path: "???" }], "en")).toBe("CR-003: Document updated")
  })
})
