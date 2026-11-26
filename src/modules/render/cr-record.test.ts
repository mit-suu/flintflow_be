/**
 * FLF-411 (U2-6): mô tả dòng §I của change request theo ngôn ngữ tài liệu.
 */
import { describe, expect, it } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import { changeKindOf, crRecordDescription, crRowDescription, describeCrChanges } from "./cr-record.js"

const spine = {
  actors: [{ id: "A04", name: "Patron" }],
  business_rules: [{ id: "BR-03", statement: "x" }]
} as unknown as Spine

describe("crRowDescription / crRecordDescription", () => {
  it("FLF-466: liệt kê đủ mã CR của dòng gộp, không trùng, rồi mô tả từ thay đổi", () => {
    const changes = [{ op: "set", path: "project.system_name" }]
    expect(crRowDescription(["CR-012", "CR-013", "CR-012"], changes, "en")).toBe("CR-012, CR-013: Update system name")
    expect(crRowDescription(["CR-012", "CR-013"], changes, "vi")).toBe("CR-012, CR-013: Cập nhật tên hệ thống")
  })

  it("không chép tiêu đề CR: luôn dựng từ thay đổi, theo ngôn ngữ tài liệu, không mã nội bộ (FLF-466 / FLF-484 lát D)", () => {
    const changes = [
      { op: "set", path: "project.system_name" },
      { op: "remove", path: "actors[id=A04]" },
      { op: "set", path: "business_rules[id=BR-03].statement" },
      { op: "set", path: "business_rules[id=BR-03].tier" }
    ]
    expect(crRowDescription(["CR-001"], changes, "en", spine)).toBe('CR-001: Update system name; Delete actor "Patron"; Update business rule BR-03')
    expect(crRecordDescription("CR-001", changes, "en", spine)).toBe('CR-001: Update system name; Delete actor "Patron"; Update business rule BR-03')
    expect(crRowDescription(["CR-002"], changes.slice(0, 1), "vi", spine)).toBe("CR-002: Cập nhật tên hệ thống")
    expect(crRecordDescription("CR-002", changes.slice(0, 1), "vi", spine)).toBe("CR-002: Cập nhật tên hệ thống")
  })

  it("phần tử không tên, mã nội bộ ⇒ chỉ loại phần tử; quá 3 thay đổi ⇒ ghi số còn lại; không dựng được ⇒ Document updated", () => {
    expect(describeCrChanges([{ op: "add", path: "screens[id=S09]" }], "en")).toBe("Add screen")
    const many = ["UC-01", "UC-02", "UC-03", "UC-04", "UC-05"].map((id) => ({ op: "set", path: `use_cases[id=${id}].description` }))
    expect(describeCrChanges(many, "en")).toBe("Update use case UC-01; Update use case UC-02; Update use case UC-03; and 2 more changes")
    expect(crRowDescription(["CR-003"], [{ op: "set", path: "???" }], "en")).toBe("CR-003: Document updated")
    expect(crRecordDescription("CR-003", [{ op: "set", path: "???" }], "en")).toBe("CR-003: Document updated")
  })
})

describe("changeKindOf", () => {
  it("add / remove lên chính phần tử ⇒ A / D; còn lại ⇒ M", () => {
    expect(changeKindOf({ op: "add", path: "use_cases[]" })).toBe("A")
    expect(changeKindOf({ op: "add", path: "use_cases[id=UC-09]" })).toBe("A")
    expect(changeKindOf({ op: "remove", path: "messages[id=MSG-63]" })).toBe("D")
    expect(changeKindOf({ op: "add", path: "use_cases[id=UC-01].function_ids" })).toBe("M")
    expect(changeKindOf({ op: "remove", path: "use_cases[id=UC-01].function_ids" })).toBe("M")
    expect(changeKindOf({ op: "set", path: "screens[id=S01].name" })).toBe("M")
    expect(changeKindOf({ op: "set", path: "project.vision" })).toBe("M")
    expect(changeKindOf({ op: "set", path: "???" })).toBe("M")
    expect(changeKindOf({ op: "add" })).toBe("M")
  })

  it("FLF-474: op remove có removed_name ⇒ dòng ghi đúng tên đã xoá dù Spine hiện có phần tử khác cùng mã", () => {
    // UC34 "Chat với shop" bị CR-003 xoá; CR-006 sau đó thêm use case mới cũng mang mã UC34 (mã bị cấp lại trước khi
    // vá FLF-474) — dòng §I của CR-003 không được đổi theo tên của use case mới.
    const reused: Spine = { use_cases: [{ id: "UC34", name: "Tích điểm thành viên" }] } as unknown as Spine
    const changes = [{ op: "remove", path: "use_cases[id=UC34]", removed_name: "Chat với shop" }]
    expect(describeCrChanges(changes, "vi", reused)).toBe('Xoá use case "Chat với shop"')
    // Không có removed_name (dữ liệu cũ, trước fix) ⇒ vẫn tra theo Spine hiện tại như cũ (tương thích ngược)
    expect(describeCrChanges([{ op: "remove", path: "use_cases[id=UC34]" }], "vi", reused)).toBe('Xoá use case "Tích điểm thành viên"')
  })
})
