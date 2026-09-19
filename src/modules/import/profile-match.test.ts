import { describe, expect, it } from "vitest"
import { parseDocument } from "./parse.service.js"
import { assignBlockSections, matchProfile, needsMappingReview } from "./profile-match.service.js"
import { makeSrsDocx } from "./testing/srs-fixture.js"
import { splitHeadingNumber, titleSimilarity } from "./text-similarity.js"
import { matchTableHeader } from "./table-header-dictionary.js"

const headingSections = async (numberedOnly = false) => {
  const { blocks } = await parseDocument(await makeSrsDocx({ numberedOnly }))
  const profile = matchProfile(blocks)
  return { blocks, profile, map: Object.fromEntries(profile.heading_map.map((h) => [h.heading_text, h])) }
}

describe("text-similarity", () => {
  it("bỏ dấu, không phân biệt hoa thường, số nhiều đơn giản", () => {
    expect(titleSimilarity("Đặc tả Use Case", "dac ta use case")).toBe(1)
    expect(titleSimilarity("Use Case Descriptions", "Use Case Description")).toBe(1)
    expect(titleSimilarity("Actors", "Glossary")).toBe(0)
  })

  it("tách số mục", () => {
    expect(splitHeadingNumber("3.2.1  Register account")).toEqual({ number: "3.2.1", title: "Register account" })
    expect(splitHeadingNumber("II. Software Requirement Specification")).toEqual({ number: "II", title: "Software Requirement Specification" })
    expect(splitHeadingNumber("Introduction")).toEqual({ number: null, title: "Introduction" })
  })
})

describe("matchTableHeader", () => {
  it("bảng UC trong section use case ⇒ độ tin cao; ngoài section ⇒ giảm độ tin", () => {
    const inSection = matchTableHeader(["Use Case ID", "Use Case Name", "Actor", "No."], "fixed:2.2.2")
    expect(inSection.entity).toBe("use_cases")
    expect(inSection.columns.map((c) => [c.field_path, c.confidence])).toEqual([
      ["use_cases[].id", 0.95],
      ["use_cases[].name", 0.95],
      ["use_cases[].actor_ids", 0.95],
      [null, 0.9]
    ])
    expect(matchTableHeader(["Use Case ID", "Use Case Name"], null).columns[0].confidence).toBe(0.7)
  })

  it("không đủ cột bắt buộc ⇒ không thực thể", () => {
    expect(matchTableHeader(["Step", "Action"], "fixed:2.2.2")).toMatchObject({ entity: null })
  })
})

describe("matchProfile", () => {
  it("heading style: khớp section cố định, nhóm, feature/function tạm, heading lạ unmapped", async () => {
    const { map, profile } = await headingSections()
    expect(map["1 Product Overview"]).toMatchObject({ section_id: "fixed:1", detected_by: "style" })
    expect(map["2 User Requirements"].section_id).toBe("group:2")
    expect(map["2.1 Actors"].section_id).toBe("fixed:2.1")
    expect(map["2.2.2 Use Case Descriptions"].section_id).toBe("fixed:2.2.2")
    expect(map["3.1.2 Screen Descriptions"].section_id).toBe("fixed:3.1.2")
    expect(map["3.2 Authentication"].section_id).toMatch(/^feature:@B\d{4}$/)
    expect(map["3.2.1 Register account"].section_id).toMatch(/^function:@B\d{4}$/)
    expect(map["3.2.1 Register account"].confidence).toBe(0.85)
    expect(map["4.2.3 Performance"].section_id).toBe("fixed:4.2.3")
    expect(map["5.1 Business Rules"].section_id).toBe("fixed:5.1")
    expect(map["5.9 Team Notes"]).toMatchObject({ section_id: "unmapped", confidence: 0.9 })
    expect(profile.language).toBe("en")
    expect(profile.required_sections).toContain("fixed:3.1.1")
    expect(profile.required_sections).not.toContain("fixed:2.1")
    expect(needsMappingReview(profile)).toBe(false)
  })

  it("bảng: cột khớp field theo section chứa bảng", async () => {
    const { profile, blocks } = await headingSections()
    const actorTable = blocks.find((b) => b.kind === "table" && b.text.startsWith("Actor"))!
    expect(profile.table_map.filter((t) => t.block_id === actorTable.block_id).map((t) => t.field_path)).toEqual(["actors[].name", "actors[].description"])
    const brTable = blocks.find((b) => b.kind === "table" && b.text.startsWith("BR ID"))!
    expect(profile.table_map.filter((t) => t.block_id === brTable.block_id).map((t) => t.field_path)).toEqual([
      "business_rules[].id",
      "business_rules[].statement"
    ])
  })

  it("heading theo mẫu số mục (không style) ⇒ độ tin ≤ 0.75, cần xác nhận mapping", async () => {
    const { map, profile } = await headingSections(true)
    expect(map["2.1 Actors"]).toMatchObject({ section_id: "fixed:2.1", detected_by: "numbering_pattern", confidence: 0.75 })
    expect(needsMappingReview(profile)).toBe(true)
  })

  it("gán section cho block theo heading gần nhất; nhóm/unmapped ⇒ null", async () => {
    const { blocks, profile } = await headingSections()
    const sections = assignBlockSections(blocks, profile.heading_map)
    const of = (text: string) => sections.get(blocks.find((b) => b.text === text)!.block_id)
    expect(of("Lumen is an online learning platform for small training centers.")).toBe("fixed:1")
    expect(of("The system shall respond within 2 seconds for 95% of requests.")).toBe("fixed:4.2.3")
    expect(of("Show an error when the password is wrong.")).toMatch(/^function:@/)
    expect(of("Internal notes that do not belong to the template.")).toBeNull()
    expect(of("2 User Requirements")).toBeNull()
  })
})
