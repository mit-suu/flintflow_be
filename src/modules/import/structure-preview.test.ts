import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { LayoutBlock } from "./step-plan.js"
import type { LayoutEntry } from "./template-profile.model.js"
import { fileKindOf, isTemplateFile, previewStructure, structureChanges, toPreview, type StructurePreview } from "./structure-preview.js"
import type { TargetStructure } from "./target-structure.js"

const entry = (order: number, section_id: string, heading_text: string, level = 1): LayoutEntry => ({ order, section_id, heading_text, level })
const heading = (id: string, text: string, section: string, level = 1): LayoutBlock => ({ block_id: id, kind: "heading", level, text, section_id: section })
const para = (id: string, text: string, section: string): LayoutBlock => ({ block_id: id, kind: "paragraph", level: null, text, section_id: section })
const AT = "2026-11-08T00:00:00.000Z"

describe("fileKindOf - khung mẫu hay SRS đã viết", () => {
  const layout = [
    entry(0, "fixed:1", "1 Overview"),
    entry(1, "fixed:2.1", "2.1 Actors"),
    entry(2, "fixed:2.2", "2.2 Use cases"),
    entry(3, "fixed:3.1.1", "3.1.1 Screen flow"),
    entry(4, "fixed:5.1", "5.1 Glossary"),
    entry(5, "group:3", "3 Functional requirements"),
    entry(6, "fixed:I", "Record of Changes"),
    entry(7, "custom:CS01", "Table of Contents")
  ]

  it("dưới 20% mục có nội dung ⇒ template; bỏ nhóm bao, Record of Changes, mục lục khỏi mẫu số", () => {
    expect(fileKindOf(layout, new Set())).toBe("template")
    // 1/5 = 20% ⇒ đã là SRS đã viết (ngưỡng < 20%)
    expect(fileKindOf(layout, new Set(["fixed:1"]))).toBe("written")
    // Record of Changes / mục lục có chữ không làm file thành "đã viết"
    expect(fileKindOf([...layout, entry(8, "fixed:3.2", "3.2 Reports"), entry(9, "fixed:4", "4 NFR")], new Set(["fixed:I", "custom:CS01", "fixed:1"]))).toBe("template")
  })

  it("file không có heading nào ⇒ template", () => {
    expect(fileKindOf([], new Set())).toBe("template")
  })
})

describe("previewStructure - màn đọc khung lúc upload", () => {
  const spine = createEmptySpine({ name: "Lumen" })

  it("giữ khung, SRS đã viết ⇒ mục có chữ thật present, mục chỉ có heading missing, chế độ 3; sắp theo thứ tự file", () => {
    const blocks = [
      heading("h1", "1 Overview", "fixed:1"),
      para("p1", "Lumen is a course management SaaS for small training centres.", "fixed:1"),
      heading("h3", "2.3 Business rules", "fixed:2.3", 2),
      heading("h2", "2.2 Use cases", "fixed:2.2", 2),
      para("p2", "Learners enrol in courses; instructors publish lessons and grade quizzes.", "fixed:2.2")
    ]
    const preview = previewStructure(blocks, new Map([["h1", "fixed:1"], ["h3", "fixed:2.3"], ["h2", "fixed:2.2"]]), spine, "fixed", AT)
    expect(preview.summary).toEqual({ present: 2, missing: 1, out_of_scope: 0, kind: "written" })
    expect(preview.resolved_mode).toBe(3)
    // Thứ tự trong file: 2.3 đứng trước 2.2
    expect(preview.sections.map((s) => [s.section_id, s.status])).toEqual([
      ["fixed:1", "present"],
      ["fixed:2.3", "missing"],
      ["fixed:2.2", "present"]
    ])
    expect(preview.computed_at).toBe(AT)
  })

  it("FLF-382: mẫu mà mục nào cũng có câu ví dụ / chỗ điền vẫn là khung mẫu (câu ví dụ không tính là nội dung khách viết)", () => {
    const ids = ["fixed:1", "fixed:2.1", "fixed:2.2", "fixed:2.3", "fixed:3.1.1"]
    const examples = [
      "e.g. The Library Management System lets librarians track borrowed books.",
      "Ví dụ: Thủ thư, Bạn đọc, Quản trị viên.",
      "Example: Register books, Borrow a book, Return a book.",
      "Hệ thống XYZ hỗ trợ tra cứu sách theo tên.",
      "Người phê duyệt: Nguyễn Văn A."
    ]
    const blocks = ids.flatMap((id, i) => [heading(`h${i}`, `${i + 1} Section ${i}`, id), para(`p${i}`, examples[i], id)])
    const preview = previewStructure(blocks, new Map(ids.map((id, i) => [`h${i}`, id])), spine, "fixed", AT)
    expect(preview.summary.kind).toBe("template")
    expect(preview.summary.missing).toBe(ids.length)
    // Có một mục khách viết thật trong 5 ⇒ 20% ⇒ SRS đã viết (ngưỡng không đổi)
    blocks.push(para("real", "Students register for a dormitory room each semester; staff assign rooms by building.", "fixed:2.1"))
    expect(previewStructure(blocks, new Map(ids.map((id, i) => [`h${i}`, id])), spine, "fixed", AT).summary.kind).toBe("written")
  })

  it("giữ khung, khung mẫu (gần như trống) ⇒ mọi mục của mẫu thiếu, kể cả mục có ví dụ - luôn chế độ 3", () => {
    const ids = ["fixed:1", "fixed:2.1", "fixed:2.2", "fixed:2.3", "fixed:3.1.1", "fixed:5.1"]
    const blocks = ids.flatMap((id, i) => [heading(`h${i}`, `${i + 1} Section ${i}`, id)])
    blocks.push(para("ex", "Example: The system shall allow the user to log in.", "fixed:1"))
    const preview = previewStructure(blocks, new Map(ids.map((id, i) => [`h${i}`, id])), spine, "fixed", AT)
    expect(preview.summary.kind).toBe("template")
    expect(preview.summary.present).toBe(0)
    expect(preview.summary.missing).toBe(ids.length)
    expect(preview.resolved_mode).toBe(3)
  })

  it("bổ sung theo mẫu chuẩn (free) ⇒ đích là mẫu FlintFlow; mục riêng của file là ngoài phạm vi, giữ vị trí trong file", () => {
    const blocks = [heading("h1", "1 Overview", "fixed:1"), para("p1", "Lumen is a course management SaaS for small training centres.", "fixed:1"), heading("c1", "Budget", "custom")]
    const preview = previewStructure(blocks, new Map([["h1", "fixed:1"]]), spine, "free", AT)
    expect(preview.resolved_mode).toBe(4)
    expect(preview.summary.out_of_scope).toBe(1)
    expect(preview.sections[0]).toMatchObject({ section_id: "fixed:1", status: "present", order: 0 })
    // Mục mẫu chuẩn file không có xếp sau mục của file
    const custom = preview.sections.findIndex((s) => s.status === "out_of_scope")
    const firstAbsent = preview.sections.findIndex((s) => s.status === "missing")
    expect(custom).toBeLessThan(firstAbsent)
  })
})

describe("toPreview - thứ tự", () => {
  it("mục không có trong file nhận thứ tự sau mọi heading của file, giữ thứ tự mẫu", () => {
    const structure: TargetStructure = {
      target: "fpt",
      intent: "free",
      resolved_mode: 4,
      missing: ["fixed:2.1", "fixed:2.2"],
      compared_at: AT,
      sections: [
        { section_id: "fixed:2.1", title: "Actors", status: "missing", owner_steps: [] },
        { section_id: "fixed:1", title: "Overview", status: "present", owner_steps: [] },
        { section_id: "fixed:2.2", title: "Use cases", status: "missing", owner_steps: [] }
      ]
    }
    const preview = toPreview(structure, [entry(0, "fixed:1", "Overview")], "written", AT)
    expect(preview.sections.map((s) => [s.section_id, s.order])).toEqual([
      ["fixed:1", 0],
      ["fixed:2.1", 2],
      ["fixed:2.2", 3]
    ])
  })
})

describe("structureChanges - kết quả cuối lệch bản sơ bộ", () => {
  const preview: StructurePreview = {
    summary: { present: 3, missing: 0, out_of_scope: 0, kind: "written" },
    resolved_mode: 1,
    intent: "fixed",
    computed_at: AT,
    sections: [
      { section_id: "fixed:1", title: "Overview", status: "present", order: 0 },
      { section_id: "fixed:3.4", title: "3.4 Security", status: "present", order: 1 },
      { section_id: "feature:P01", title: "3.2 Courses", status: "present", order: 2 },
      { section_id: "custom:CS01", title: "Budget", status: "present", order: 3 }
    ]
  }
  const final = (status34: "present" | "missing"): TargetStructure => ({
    target: "template",
    intent: "fixed",
    resolved_mode: status34 === "missing" ? 3 : 1,
    missing: status34 === "missing" ? ["fixed:3.4"] : [],
    compared_at: AT,
    sections: [
      { section_id: "fixed:1", title: "Overview", status: "present", owner_steps: [] },
      { section_id: "fixed:3.4", title: "3.4 Security", status: status34, owner_steps: [] },
      { section_id: "feature:F01", title: "3.2 Courses", status: "present", owner_steps: [] },
      // Finalize sinh thêm phần nối ⇒ mục riêng cùng tiêu đề mang số khác
      { section_id: "custom:CS03", title: "Budget", status: "present", owner_steps: [] }
    ]
  })
  const realId = (id: string) => (id === "feature:P01" ? "feature:F01" : id)

  it("mục 3.4 tưởng có nội dung hoá ra chỉ là hướng dẫn ⇒ đúng một dòng", () => {
    expect(structureChanges(preview, final("missing"), realId)).toEqual([{ section_id: "fixed:3.4", title: "3.4 Security", from: "present", to: "missing" }])
  })

  it("mục ngoài phạm vi / phần nối chỉ có ở bản cuối không phải thay đổi cần báo", () => {
    const extra = final("present")
    extra.sections.push({ section_id: "custom:CS04", title: "custom:CS04", status: "out_of_scope", owner_steps: [] })
    expect(structureChanges(preview, extra, realId)).toEqual([])
  })

  it("khớp ⇒ rỗng (id tạm của tính năng đổi sang id thật, mục riêng khớp theo tiêu đề)", () => {
    expect(structureChanges(preview, final("present"), realId)).toEqual([])
  })
})

describe("isTemplateFile", () => {
  const preview = (kind: "written" | "template") => ({ structure_preview: { ...toPreview({ target: "template", intent: "fixed", resolved_mode: 3, missing: [], compared_at: AT, sections: [] }, [], kind, AT) } })

  it("chỉ giữ khung (fixed) + khung mẫu; hồ sơ cũ không có bản sơ bộ ⇒ dự án mới có mẫu bắt buộc", () => {
    expect(isTemplateFile({ template_intent: "fixed", start_kind: "existing" }, preview("template"))).toBe(true)
    expect(isTemplateFile({ template_intent: "fixed", start_kind: "existing" }, preview("written"))).toBe(false)
    expect(isTemplateFile({ template_intent: "free", start_kind: "existing" }, preview("template"))).toBe(false)
    expect(isTemplateFile({ template_intent: "fixed", start_kind: "new" }, null)).toBe(true)
    expect(isTemplateFile({ template_intent: "fixed", start_kind: "existing" }, { structure_preview: null })).toBe(false)
    expect(isTemplateFile(null, preview("template"))).toBe(false)
  })
})
