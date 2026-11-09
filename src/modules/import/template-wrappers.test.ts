import { describe, expect, it } from "vitest"
import { templateWrapperIds } from "./template-wrappers.js"
import type { LayoutEntry } from "./template-profile.model.js"

const e = (order: number, section_id: string, heading_text: string, level: number): LayoutEntry => ({ order, section_id, heading_text, level })

describe("templateWrapperIds (FLF-278 — heading bao của mẫu bắt buộc)", () => {
  it("mục riêng có heading con sâu hơn ngay sau ⇒ heading bao; mục riêng lá / mục FPT / nhóm thì không", () => {
    const layout = [
      e(0, "fixed:1", "1 Introduction", 1),
      e(1, "custom:CS01", "1.1 Document Conventions", 2),
      e(2, "custom:CS02", "2 Overall Description", 1),
      e(3, "fixed:2.1", "2.1 User Classes", 2),
      e(4, "group:3", "3 System Features", 1),
      e(5, "custom:CS03", "9 Support Contacts", 1)
    ]
    expect([...templateWrapperIds(layout)]).toEqual(["custom:CS02"])
  })

  it("heading tính năng có chức năng con (3.2 Course Registration › 3.2.1 …) ⇒ heading bao; tính năng không có heading con thì không", () => {
    const layout = [
      e(0, "feature:F01", "3.2 Course Registration", 2),
      e(1, "function:FN01", "3.2.1 Register for course sections", 3),
      e(2, "function:FN02", "3.2.2 Drop a course section", 3),
      e(3, "feature:F02", "3.3 Attendance", 2),
      e(4, "function:FN03", "3.3.1 Take attendance", 3),
      e(5, "feature:F03", "3.6 Notifications", 2),
      e(6, "fixed:4.1", "4.1 External Interfaces", 2)
    ]
    expect([...templateWrapperIds(layout)]).toEqual(["feature:F01", "feature:F02"])
  })

  it("bỏ qua phần nối (tiêu đề rỗng) khi tìm heading kế tiếp; xét theo `order`, không theo thứ tự mảng", () => {
    const layout = [
      e(3, "custom:CS05", "Known Risks", 2),
      e(0, "custom:CS02", "Project Notes", 1),
      e(1, "custom:CS03", "", 2),
      e(2, "fixed:5.4", "Assumptions", 2),
      e(4, "custom:CS06", "Glossary", 1),
      e(5, "custom:CS07", "", 2)
    ]
    expect([...templateWrapperIds(layout)]).toEqual(["custom:CS02"])
  })
})
