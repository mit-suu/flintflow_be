import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import { bindFixedTemplateHeadings, isContentSlot, overlapsOf, slotHasData, slotOverlaps, suggestSlot, withSlotParents } from "./content-slots.js"

describe("content-slots (FLF-278 trên FLF-335/336)", () => {
  it("gợi ý theo tiêu đề mẫu IEEE; luật chặn cho mục Spine không có dữ liệu", () => {
    expect(suggestSlot("1.1 Purpose")).toBe("slot:vision")
    expect(suggestSlot("1.4 Product Scope")).toBe("slot:scope")
    expect(suggestSlot("2.5 Assumptions and Dependencies")).toBe("slot:assumptions")
    expect(suggestSlot("2.4 Operating Environment")).toBe("slot:platforms")
    expect(suggestSlot("1.6 References")).toBeNull()
    expect(suggestSlot("3.2 Hardware Interfaces")).toBeNull()
    expect(suggestSlot("Phạm vi dự án")).toBe("slot:scope")
  })

  it("chồng lấn với mục FPT cha; mục cha có mặt qua phần nhỏ", () => {
    expect(isContentSlot("slot:vision")).toBe(true)
    expect(overlapsOf("fixed:1")).toContain("slot:scope")
    expect(slotOverlaps(["fixed:1", "slot:scope", "fixed:2.1"])).toEqual([["fixed:1", "slot:scope"]])
    expect(slotOverlaps(["slot:vision", "slot:scope"])).toEqual([])
    expect(withSlotParents(["slot:risks"])).toEqual(new Set(["slot:risks", "fixed:5.4"]))
  })

  it("dữ liệu của từng phần nhỏ", () => {
    const spine = createEmptySpine({ name: "X" })
    expect(slotHasData(spine, "slot:vision")).toBe(false)
    spine.project.vision = "A bank app"
    spine.project.release_scope = { in: ["Transfers"], out: [] }
    expect(slotHasData(spine, "slot:vision")).toBe(true)
    expect(slotHasData(spine, "slot:scope")).toBe(true)
    expect(slotHasData(spine, "slot:risks")).toBe(false)
  })

  it("bindFixedTemplateHeadings: cha cùng mục / cùng mục cha của phần nhỏ với con ⇒ heading bao; anh em cùng mục không đổi", () => {
    const h = (heading_text: string, section_id: string, level: number) => ({ heading_text, section_id, level })
    const out = bindFixedTemplateHeadings([
      h("1. Introduction", "fixed:1", 1),
      h("1.1 Purpose", "fixed:1", 2),
      h("1.3 Definitions", "fixed:5.5", 2),
      h("3.1 External Interface Requirements", "fixed:4.1", 2),
      h("3.1.2 Software Interfaces", "fixed:4.1", 3),
      h("3.5.1 Reliability", "fixed:4.2.2", 3),
      h("3.5.2 Availability", "fixed:4.2.2", 3)
    ])
    expect(out.map((e) => e.section_id)).toEqual(["unmapped", "slot:vision", "fixed:5.5", "unmapped", "fixed:4.1", "fixed:4.2.2", "fixed:4.2.2"])
    // Thiếu cấp heading ⇒ chỉ gán phần nhỏ
    expect(bindFixedTemplateHeadings([{ heading_text: "1. Introduction", section_id: "fixed:1" }, { heading_text: "1.1 Purpose", section_id: "fixed:1" }]).map((e) => e.section_id)).toEqual(["fixed:1", "slot:vision"])
  })
})
