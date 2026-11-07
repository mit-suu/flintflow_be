import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import type { TemplateContextEntry } from "../import/template-context.js"
import { buildTemplateStepContext, templateEntriesForStep } from "./template-guidance.js"

const ctx = (section_id: string, heading: string): TemplateContextEntry => ({
  section_id,
  heading,
  guidance: [`Viết ${heading}`],
  passages: [{ text: "Ví dụ: Hệ thống quản lý thư viện", kind: "example" }],
  table_columns: []
})

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Quản lý kho" })
  s.custom_sections = [{ id: "CS02", heading: "Dự toán", level: 1, blocks: [], source: "import" }]
  return s
}

const entries = [ctx("fixed:1", "1 Product Overview"), ctx("fixed:2.1", "2.1 Actors"), ctx("custom:CS02", "Dự toán")]

describe("FLF-378 template-guidance — prompt bước soạn nhận mẫu bắt buộc", () => {
  it("Brief (B-1 / S-1) đọc cả mẫu + luật dùng mẫu trong Brief; không ghi mục riêng", () => {
    expect(templateEntriesForStep(entries, "B-1.1").map((e) => e.section_id)).toEqual(["fixed:1", "fixed:2.1", "custom:CS02"])
    const brief = buildTemplateStepContext(entries, "S-1.1", spine())
    expect(brief.guidance).toContain("### Using the customer template in the Brief")
    expect(brief.customSections).toEqual([])
  })

  it("bước soạn chỉ nhận mục mẫu nó sở hữu (S-3.1 ⇒ 2.1 Actors), đủ nhãn guidance / example", () => {
    const s31 = buildTemplateStepContext(entries, "S-3.1", spine())
    expect(s31.guidance).toContain("### Template section: 2.1 Actors")
    expect(s31.guidance).not.toContain("1 Product Overview")
    expect(s31.guidance).toContain("Template guidance:")
    expect(s31.guidance).toContain("DO NOT copy")
    expect(s31.guidance).not.toContain("Using the customer template in the Brief")
  })

  it("mục riêng của mẫu ⇒ S-8.1 soạn: thấy mục + luật ghi custom_sections", () => {
    const s81 = buildTemplateStepContext(entries, "S-8.1", spine())
    expect(s81.customSections).toEqual([{ id: "CS02", heading: "Dự toán", level: 1, blocks: [] }])
    expect(s81.guidance).toContain("\"path\":\"custom_sections[id=<id>]\"")
  })

  it("không có ngữ cảnh mẫu (dự án khác) ⇒ rỗng", () => {
    expect(buildTemplateStepContext(null, "S-3.1", spine())).toEqual({ guidance: "", customSections: [], slotWrites: [], slotProjection: {} })
  })

  it("phần nhỏ IEEE không có bước pipeline: References ⇒ S-8.1 ghi references[] + skill references-list; Apportioning ⇒ S-9.4", () => {
    const withSlots = [...entries, ctx("slot:references", "1.4 References"), ctx("slot:apportioning", "5.4 Apportioning of Requirements")]
    const s81 = buildTemplateStepContext(withSlots, "S-8.1", spine())
    expect(s81.slotWrites).toEqual(["references"])
    expect(s81.slotProjection).toEqual({ references: [] })
    expect(s81.guidance).toContain("### Template section: 1.4 References")
    expect(s81.guidance).toContain("## Skill for template section (references-list)")
    const s94 = buildTemplateStepContext(withSlots, "S-9.4", spine())
    expect(s94.guidance).toContain("5.4 Apportioning of Requirements")
    expect(s94.slotWrites).toEqual([])
  })
})
