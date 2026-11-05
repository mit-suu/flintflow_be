import { describe, expect, it } from "vitest"
import { targetSectionsText, templateGuidanceBySection } from "./propose.service.js"
import { createEmptySpine } from "../spine/spine.repository.js"

const profile = {
  heading_map: [
    { heading_text: "2. Product Overview", guidance: "Mô tả sản phẩm ở mức tổng quan" },
    { heading_text: "2.1 Product Perspective", guidance: "Nêu hệ thống liên quan và sơ đồ ngữ cảnh" },
    { heading_text: "3.3.1 Performance", guidance: "Ghi chỉ số đo được: thời gian phản hồi, số người dùng đồng thời" },
    { heading_text: "1.4 References" }
  ],
  layout: [
    { heading_text: "2. Product Overview", level: 1, section_id: "fixed:1" },
    { heading_text: "2.1 Product Perspective", level: 2, section_id: "slot:context" },
    { heading_text: "3.3.1 Performance", level: 3, section_id: "fixed:4.2.3" },
    { heading_text: "1.4 References", level: 2, section_id: "custom:c1" }
  ]
}

describe("FLF-364 (L5) — hướng dẫn của mẫu vào prompt C-4", () => {
  it("hướng dẫn theo mục, ghép hướng dẫn heading cha; mục không có hướng dẫn / không có profile ⇒ không có", () => {
    const g = templateGuidanceBySection(profile)
    expect(g.get("fixed:1")).toBe("Mô tả sản phẩm ở mức tổng quan")
    expect(g.get("slot:context")).toBe("Mô tả sản phẩm ở mức tổng quan — Nêu hệ thống liên quan và sơ đồ ngữ cảnh")
    expect(g.has("custom:c1")).toBe(false)
    expect(templateGuidanceBySection(null).size).toBe(0)
  })

  it("target_sections kèm Template guidance + Expected content (ISO 29148) cho mục đang sửa; không hướng dẫn ⇒ như cũ", () => {
    const spine = createEmptySpine()
    const g = templateGuidanceBySection(profile)
    const text = targetSectionsText(spine, { targets: { entity_paths: ["fixed:4.2.3"] } } as never, [{ path: "nfrs[id=NFR-01].statement", section_id: "fixed:4.2.3" }], g)
    expect(text).toMatch(/Template guidance: .*Ghi chỉ số đo được/)
    expect(text).toContain("Expected content (ISO 29148): static and dynamic numeric requirements")
    const edited = targetSectionsText(spine, { targets: { entity_paths: [] } } as never, [{ path: "project.vision", section_id: "slot:context" }], g)
    expect(edited).toContain("Template guidance of the sections being edited")
    expect(edited).toContain("Nêu hệ thống liên quan")
    expect(targetSectionsText(spine, { targets: { entity_paths: [] } } as never, [{ path: "project.vision", section_id: "fixed:1" }])).toBe("(none named)")
  })
})
