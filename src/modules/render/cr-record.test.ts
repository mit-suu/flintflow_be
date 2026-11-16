/**
 * FLF-411 (U2-6): mô tả dòng §I của change request theo ngôn ngữ tài liệu.
 */
import { describe, expect, it } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import { crRecordDescription, describeCrChanges } from "./cr-record.js"

const spine = {
  actors: [{ id: "A04", name: "Patron" }],
  business_rules: [{ id: "BR-03", statement: "x" }]
} as unknown as Spine

describe("crRecordDescription", () => {
  it("tiêu đề cùng ngôn ngữ tài liệu ⇒ giữ lời người dùng", () => {
    expect(crRecordDescription("CR-001", ["CR-001: Faster response time"], [], "en")).toBe("CR-001: Faster response time")
    expect(crRecordDescription("CR-001", ["CR-001: Đổi tên hệ thống"], [], "vi")).toBe("CR-001: Đổi tên hệ thống")
  })

  it("tiêu đề khác ngôn ngữ ⇒ mô tả từ thay đổi, theo ngôn ngữ tài liệu, không mã nội bộ", () => {
    const changes = [
      { op: "set", path: "project.system_name" },
      { op: "remove", path: "actors[id=A04]" },
      { op: "set", path: "business_rules[id=BR-03].statement" },
      { op: "set", path: "business_rules[id=BR-03].tier" }
    ]
    expect(crRecordDescription("CR-001", ["CR-001: Đổi tên hệ thống thành TechMart Store nhé"], changes, "en", spine)).toBe(
      'CR-001: Update system name; Delete actor "Patron"; Update business rule BR-03'
    )
    expect(crRecordDescription("CR-002", ["CR-002: Rename the system"], changes.slice(0, 1), "vi", spine)).toBe("CR-002: Cập nhật tên hệ thống")
  })

  it("phần tử không tên, mã nội bộ ⇒ chỉ loại phần tử; quá 3 thay đổi ⇒ ghi số còn lại; không dựng được ⇒ Document updated", () => {
    expect(describeCrChanges([{ op: "add", path: "screens[id=S09]" }], "en")).toBe("Add screen")
    const many = ["UC-01", "UC-02", "UC-03", "UC-04", "UC-05"].map((id) => ({ op: "set", path: `use_cases[id=${id}].description` }))
    expect(describeCrChanges(many, "en")).toBe("Update use case UC-01; Update use case UC-02; Update use case UC-03; and 2 more changes")
    expect(crRecordDescription("CR-003", ["CR-003: Sửa giúp"], [{ op: "set", path: "???" }], "en")).toBe("CR-003: Document updated")
  })
})
