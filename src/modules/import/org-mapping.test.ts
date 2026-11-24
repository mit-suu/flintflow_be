import { describe, expect, it } from "vitest"
import { applyMatchedOrgMapping, pickOrgTemplate, type OrgTemplateCandidate } from "./org-mapping.js"
import type { HeadingMapEntry } from "./template-profile.model.js"

const entry = (n: number, heading_text: string, section_id = "unmapped", confidence = 0.5): HeadingMapEntry => ({
  block_id: `B${String(n).padStart(4, "0")}`,
  heading_text,
  section_id,
  confidence,
  detected_by: "style",
  confirmed: false
})

const bank: OrgTemplateCandidate = {
  template_id: "t-bank",
  version: 2,
  headings: [
    { heading_text: "1 Giới thiệu", section_id: "fixed:1" },
    { heading_text: "2 Nghiệp vụ ngân hàng", section_id: "fixed:2.2" },
    { heading_text: "3 Màn hình", section_id: "fixed:3.1.2" },
    { heading_text: "4 Quy định nội bộ", section_id: "fixed:5.1" },
    { heading_text: "5 Phụ lục riêng", section_id: "unmapped" }
  ]
}
const hospital: OrgTemplateCandidate = {
  template_id: "t-his",
  version: 1,
  headings: [
    { heading_text: "Tổng quan bệnh viện", section_id: "fixed:1" },
    { heading_text: "Khoa phòng", section_id: "fixed:2.1" },
    { heading_text: "Quy trình khám", section_id: "fixed:2.2" }
  ]
}

describe("FLF-459 - I-3 tự khớp mẫu thư viện org", () => {
  it("file điền theo mẫu (thêm heading tính năng, số mục khác) ⇒ khớp đúng mẫu, ghép theo tên + thứ tự, áp mapping Lead đã xác nhận", () => {
    const file = [
      entry(1, "1. Giới thiệu", "fixed:1", 1),
      entry(2, "2. Nghiệp vụ ngân hàng"),
      entry(3, "Chuyển tiền liên ngân hàng", "feature:@B0003", 0.7),
      entry(4, "3. Màn hình"),
      entry(5, "4. Quy định nội bộ"),
      entry(6, "5. Phụ lục riêng", "fixed:5.4", 0.9)
    ]
    const hit = pickOrgTemplate(file, [hospital, bank])
    expect(hit).toMatchObject({ template_id: "t-bank", version: 2 })
    const out = applyMatchedOrgMapping(file, hit!)
    expect(out.map((e) => [e.heading_text, e.section_id, e.confidence, e.confirmed])).toEqual([
      ["1. Giới thiệu", "fixed:1", 1, true],
      ["2. Nghiệp vụ ngân hàng", "fixed:2.2", 1, true],
      ["Chuyển tiền liên ngân hàng", "feature:@B0003", 0.7, false],
      ["3. Màn hình", "fixed:3.1.2", 1, true],
      ["4. Quy định nội bộ", "fixed:5.1", 1, true],
      ["5. Phụ lục riêng", "unmapped", 1, true]
    ])
  })

  it("phủ dưới 80% heading của mẫu, hoặc dưới 3 heading ⇒ không khớp mẫu nào (khớp như mẫu mới của riêng dự án)", () => {
    expect(pickOrgTemplate([entry(1, "Giới thiệu"), entry(2, "Nghiệp vụ ngân hàng"), entry(3, "Màn hình")], [bank])).toBeNull()
    expect(pickOrgTemplate([entry(1, "Tổng quan bệnh viện"), entry(2, "Khoa phòng")], [hospital])).toBeNull()
    expect(pickOrgTemplate([entry(1, "Introduction"), entry(2, "Purpose")], [])).toBeNull()
  })

  it("thứ tự khác mẫu không ghép chéo; nhiều mẫu đạt ⇒ nhiều heading ghép nhất, bằng nhau thì bản mới hơn", () => {
    const reordered = [entry(1, "Quy trình khám"), entry(2, "Tổng quan bệnh viện"), entry(3, "Khoa phòng")]
    expect(pickOrgTemplate(reordered, [hospital])).toBeNull()
    const file = [entry(1, "Tổng quan bệnh viện"), entry(2, "Khoa phòng"), entry(3, "Quy trình khám")]
    expect(pickOrgTemplate(file, [hospital, { ...hospital, version: 3 }])?.version).toBe(3)
  })
})
