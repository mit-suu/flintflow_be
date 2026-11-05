import { describe, expect, it } from "vitest"
import { ownerKeyOf, ownerSkillText } from "./propose.service.js"
import { partOfHeading, skillOfPart } from "../import/part-bank.js"

const spine = {
  custom_sections: [
    { id: "c1", heading: "1.5 Document Overview", level: 2, blocks: [], source: "import" as const },
    { id: "c2", heading: "Sequence Diagrams", level: 3, blocks: [], source: "import" as const },
    { id: "c3", heading: "References", level: 2, blocks: [], source: "import" as const },
    { id: "c4", heading: "Ghi chú nhóm", level: 2, blocks: [], source: "import" as const }
  ]
}

describe("FLF-363 (D4) — skill cho vị trí CR trong mục giữ nguyên văn", () => {
  it("heading mục riêng khớp phần của ngân hàng ⇒ skill của phần; không khớp / chưa có skill ⇒ không skill", () => {
    expect(ownerKeyOf(spine, { owner_step: null, section_id: "custom:c1" })).toBe("skill:product-overview")
    expect(ownerKeyOf(spine, { owner_step: null, section_id: "custom:c2" })).toBe("skill:actors-and-usecases")
    // FLF-365: References có skill riêng
    expect(ownerKeyOf(spine, { owner_step: null, section_id: "custom:c3" })).toBe("skill:references-list")
    expect(ownerKeyOf(spine, { owner_step: null, section_id: "custom:c4" })).toBe("")
    // Có step sở hữu ⇒ giữ nguyên
    expect(ownerKeyOf(spine, { owner_step: "S-6.4", section_id: "fixed:4.2.3" })).toBe("S-6.4")
  })

  it("khoá skill ⇒ nạp đúng skill; không khoá ⇒ câu mục tự do", () => {
    expect(ownerSkillText("skill:product-overview")).not.toMatch(/^\(none/)
    expect(ownerSkillText("")).toMatch(/^\(none — free-form/)
  })

  it("skillOfPart theo plan §2.4", () => {
    const skill = (heading: string) => {
      const part = partOfHeading(heading)
      return part ? skillOfPart(part) : null
    }
    expect(skill("Operating Environment")).toBe("product-overview")
    expect(skill("Logical Database Requirements")).toBe("entities-erd")
    expect(skill("Performance Requirements")).toBe("nfr-quality-attributes")
    expect(skill("Assumptions and Dependencies")).toBe("appendix-content")
    expect(skill("Glossary")).toBe("glossary")
    expect(skill("Verification")).toBe("verification-matrix")
    expect(skill("Apportioning of Requirements")).toBe("requirement-apportioning")
  })
})

describe("FLF-364 (L6) — skill theo chữ hướng dẫn khi heading mục riêng không khớp", () => {
  it("hướng dẫn nhắc đúng một phần có skill ⇒ skill đó; nhắc nhiều phần ⇒ không skill", () => {
    const block = (text: string) => ({ kind: "paragraph" as const, text })
    const s = {
      custom_sections: [
        { id: "g1", heading: "Kế hoạch đào tạo", level: 2, blocks: [block("[Mô tả logical database requirements cho dữ liệu đào tạo]")], source: "import" as const },
        { id: "g2", heading: "Lịch họp nhóm", level: 2, blocks: [block("[Nêu business rules và performance requirements]")], source: "import" as const }
      ]
    } as never
    expect(ownerKeyOf(s, { owner_step: null, section_id: "custom:g1" })).toBe("skill:entities-erd")
    expect(ownerKeyOf(s, { owner_step: null, section_id: "custom:g2" })).toBe("")
  })
})
