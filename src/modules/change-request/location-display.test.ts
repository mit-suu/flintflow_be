/**
 * Lỗi #6 (test FLF-447): thẻ CR cho vị trí `project` — đúng mục theo field bị đổi, Trước / Sau là giá trị của chính field đó
 * (không phải tên dự án).
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import { titleOfSection } from "../import/gap-report.service.js"
import type { LayoutEntry } from "../import/template-profile.model.js"
import { changedProjectFields, locationDisplay } from "./location-display.js"
import { projectFieldsOfOps, projectSectionOf, valueText } from "./spine-location.js"

const spine = () => {
  const s = createEmptySpine({ name: "Test FLF-447 - ChoViet Mini" })
  s.project.goals = ["Kết nối người mua và người bán", "Thanh toán an toàn"]
  return s
}

const layout: LayoutEntry[] = [
  { order: 0, heading_text: "1. Giới thiệu", level: 1, section_id: "fixed:1" },
  { order: 1, heading_text: "1.1 Mục tiêu", level: 2, section_id: "slot:goals" },
  { order: 2, heading_text: "1.2 Phạm vi", level: 2, section_id: "slot:scope" },
  { order: 3, heading_text: "1.4 Hệ thống bên ngoài", level: 2, section_id: "fixed:1" }
]

const goalsProposal = (s: ReturnType<typeof spine>) => {
  const after = { ...s.project, goals: ["Kết nối người mua và người bán", "Thanh toán an toàn", "Giao hàng trong 24 giờ"] }
  return {
    old_text: valueText(s.project),
    new_text: valueText(after),
    comment_text: null,
    spine_ops: [{ op: "set", path: "project.goals", value: after.goals }]
  }
}

describe("Lỗi #6 - vị trí project", () => {
  it("CR sửa project.goals ⇒ nhãn field, Trước / Sau là danh sách mục tiêu (mỗi dòng một mục)", () => {
    const s = spine()
    const d = locationDisplay(s, "project", "edit", goalsProposal(s))
    expect(d).toEqual({
      kind: "project",
      label: "Mục tiêu",
      change: "edit",
      before: "Kết nối người mua và người bán\nThanh toán an toàn",
      after: "Kết nối người mua và người bán\nThanh toán an toàn\nGiao hàng trong 24 giờ"
    })
    expect(d.before).not.toContain("ChoViet")
  })

  it("mục của vị trí: goals ⇒ slot:goals khi layout có ⇒ tiêu đề '1.1 Mục tiêu'", () => {
    const s = spine()
    const section = projectSectionOf(changedProjectFields(goalsProposal(s)), layout)
    expect(section).toBe("slot:goals")
    expect(titleOfSection(s, section!, layout)).toBe("1.1 Mục tiêu")
  })

  it("layout không có phần nhỏ ⇒ fixed:1; không biết field ⇒ null; field khác ⇒ fixed:1", () => {
    expect(projectSectionOf(["goals"], layout.filter((l) => l.section_id !== "slot:goals"))).toBe("fixed:1")
    expect(projectSectionOf(["goals"], undefined)).toBe("fixed:1")
    expect(projectSectionOf([], layout)).toBeNull()
    expect(projectSectionOf(["name"], layout)).toBe("fixed:1")
    expect(projectSectionOf(["release_scope"], layout)).toBe("slot:scope")
  })

  it("field lấy từ op (kể cả path sâu), không có op thì so trước / sau", () => {
    expect(projectFieldsOfOps([{ op: "add", path: "project.release_scope.in", value: "x" }, { op: "set", path: "project.goals" }, { op: "set", path: "actors[id=A01].name" }])).toEqual([
      "release_scope",
      "goals"
    ])
    const s = spine()
    const p = { ...goalsProposal(s), spine_ops: [] }
    expect(changedProjectFields(p)).toEqual(["goals"])
  })

  it("phạm vi phát hành ⇒ tách Trong / Ngoài phạm vi", () => {
    const s = spine()
    const after = { ...s.project, release_scope: { in: ["Đăng tin"], out: ["Ví điện tử"] } }
    const d = locationDisplay(s, "project", "edit", {
      old_text: valueText(s.project),
      new_text: valueText(after),
      comment_text: null,
      spine_ops: [{ op: "set", path: "project.release_scope", value: after.release_scope }]
    })
    expect(d.label).toBe("Phạm vi phát hành")
    expect(d.before).toBe("")
    expect(d.after).toBe("Trong phạm vi: Đăng tin\nNgoài phạm vi: Ví điện tử")
  })

  it("chưa có đề xuất ⇒ giữ hành vi cũ (nhãn tên dự án)", () => {
    expect(locationDisplay(spine(), "project", null, null).label).toBe("Test FLF-447 - ChoViet Mini")
  })

  it("titleOfSection: nhiều heading cùng fixed:1 ⇒ heading cấp nông nhất", () => {
    const shuffled = [layout[3], layout[0]]
    expect(titleOfSection(spine(), "fixed:1", shuffled)).toBe("1. Giới thiệu")
  })
})
