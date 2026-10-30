import { describe, expect, it } from "vitest"
import { applyOrgMapping, normalizeTitle } from "./org-mapping.js"
import { aggregateTemplateGaps } from "./template-gaps.js"
import type { HeadingMapEntry } from "./template-profile.model.js"

const entry = (block_id: string, heading_text: string, section_id: string, confidence = 0.5): HeadingMapEntry => ({
  block_id, heading_text, section_id, confidence, detected_by: "style", confirmed: false
})

describe("org-mapping (FLF-278 trên FLF-335/336)", () => {
  it("normalizeTitle bỏ số gõ tay, dấu câu, hoa/thường; giữ dấu tiếng Việt; không ăn chữ cái đầu", () => {
    expect(normalizeTitle("2.4 Hardware  Interfaces")).toBe("hardware interfaces")
    expect(normalizeTitle("A. Glossary & References")).toBe("glossary references")
    expect(normalizeTitle("Introduction")).toBe("introduction")
    expect(normalizeTitle("Quy ước tài liệu")).toBe("quy ước tài liệu")
  })

  it("áp mapping đã lưu theo thứ tự + tiêu đề; heading lệch giữ đề xuất của matcher", () => {
    const fresh = [entry("B1", "1 Introduction", "unmapped"), entry("B2", "1.1 Purpose", "fixed:1"), entry("B3", "9 New heading", "unmapped")]
    const saved = [
      { heading_text: "1 Introduction", section_id: "group:1" },
      { heading_text: "1.1 Purpose", section_id: "slot:vision" },
      { heading_text: "9 Other heading", section_id: "fixed:5.4" }
    ]
    const out = applyOrgMapping(fresh, saved)
    expect(out.map((e) => [e.section_id, e.confirmed, e.confidence])).toEqual([
      ["group:1", true, 1],
      ["slot:vision", true, 1],
      ["unmapped", false, 0.5]
    ])
  })
})

describe("aggregateTemplateGaps", () => {
  it("gộp theo tiêu đề chuẩn hoá, đếm dự án còn trống (chữ hướng dẫn `[…]` tính là trống)", () => {
    const block = (text: string) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })
    const rows = aggregateTemplateGaps(
      [
        { sections: [{ id: "CS01", title: "Hardware Interfaces" }, { id: "CS02", title: "References" }], spineSections: [{ id: "CS01", blocks: [block("[Describe devices.]")] }, { id: "CS02", blocks: [block("IEEE 830")] }] },
        { sections: [{ id: "CS05", title: "2.4 Hardware interfaces" }], spineSections: [{ id: "CS05", blocks: [] }] }
      ],
      10
    )
    expect(rows).toEqual([
      { key: "hardware interfaces", samples: ["Hardware Interfaces", "2.4 Hardware interfaces"], projects: 2, empty: 2, suggested_destination: null },
      { key: "references", samples: ["References"], projects: 1, empty: 0, suggested_destination: null }
    ])
  })
})
