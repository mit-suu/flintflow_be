import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { compareTargetStructure } from "./target-structure.js"
import { fileSectionTitle, fixedSectionArrayFilled, gapFillRequestOf, isFixedExisting, recompareTargetStructure } from "./target-structure.service.js"
import type { LayoutEntry } from "./template-profile.model.js"

const entry = (order: number, section_id: string, heading_text: string, level = 2): LayoutEntry => ({ order, section_id, heading_text, level })
const spineWith = (over: Partial<Spine> = {}): Spine => ({ ...createEmptySpine({ name: "Lumen" }), ...over })

describe("FLF-382 — luồng B sau bản gốc", () => {
  const existingFixed = { start_kind: "existing", template_intent: "fixed" }

  it("chỉ luồng B + Hoàn thiện + chế độ 3 còn mục thiếu ⇒ cần CR bổ sung", () => {
    const at = new Date("2026-11-06T00:00:00Z")
    const structure = { resolved_mode: 3 as const, missing: ["fixed:5.5"] }
    expect(isFixedExisting(existingFixed)).toBe(true)
    expect(gapFillRequestOf(existingFixed, true, structure, at)).toEqual({ section_ids: ["fixed:5.5"], at })
    expect(gapFillRequestOf(existingFixed, false, structure, at)).toBeNull()
    expect(gapFillRequestOf(existingFixed, true, { resolved_mode: 1, missing: [] }, at)).toBeNull()
    expect(gapFillRequestOf({ start_kind: "existing", template_intent: "free" }, true, { resolved_mode: 4, missing: ["fixed:2.1"] }, at)).toBeNull()
    expect(gapFillRequestOf({ start_kind: "new", template_intent: "fixed" }, true, structure, at)).toBeNull()
    expect(gapFillRequestOf(null, true, structure, at)).toBeNull()
  })

  it("I-5 chạy lại sau CR: mục vừa soạn ⇒ present; mục có chữ trong file giữ present", () => {
    const layout = [entry(0, "fixed:5.1", "5.1 Notes"), entry(1, "fixed:5.5", "5.5 Glossary"), entry(2, "custom:CS02", "5.10 Document Conventions")]
    const before = spineWith({ custom_sections: [{ id: "CS02", heading: "5.10 Document Conventions", level: 2, source: "import", blocks: [{ kind: "paragraph", text: "[Describe]", rows: null, image_ref: null }] }] })
    const prev = compareTargetStructure(layout, new Set(["fixed:5.1"]), before, "fixed")
    expect(prev.missing).toEqual(["fixed:5.5", "custom:CS02"])

    const after = spineWith({
      glossary: [{ id: "GL-01", term: "LMS", definition: "Learning management system" }],
      custom_sections: [{ ...before.custom_sections[0], blocks: [{ kind: "paragraph", text: "Bold marks a term.", rows: null, image_ref: null }] }]
    })
    expect(fixedSectionArrayFilled(after, "fixed:5.5")).toBe(true)
    expect(fixedSectionArrayFilled(after, "fixed:5.1")).toBe(false) // có luật tất định riêng
    const next = recompareTargetStructure(prev, layout, after, "2026-11-06T00:00:00.000Z")
    expect(next.missing).toEqual([])
    expect(next.resolved_mode).toBe(1)
    expect(next.sections.find((s) => s.section_id === "fixed:5.1")?.status).toBe("present")
  })

  it("tiêu đề mục theo file khách, không bao giờ là mã nội bộ", () => {
    const layout = [{ ...entry(0, "fixed:5.5", "Glossary"), number_label: "5.5" }]
    expect(fileSectionTitle("fixed:5.5", { sections: [{ section_id: "fixed:5.5", title: "5.5 Glossary", status: "missing", owner_steps: [] }] }, layout)).toBe("5.5 Glossary")
    expect(fileSectionTitle("fixed:5.5", null, layout)).toBe("5.5 Glossary")
    expect(fileSectionTitle("slot:assumptions", null, [])).toBe("Assumptions")
    expect(fileSectionTitle("custom:CS09", null, [])).toBe("")
  })
})
