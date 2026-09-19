import { describe, expect, it } from "vitest"
import { parseDocument } from "./parse.service.js"
import { assignBlockSections, matchHeadings, matchProfile, missingRequiredSections, needsMappingReview, type ProfileBlock } from "./profile-match.service.js"
import { MAPPING_CONFIDENCE_THRESHOLD } from "./import.constants.js"
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

const heading = (n: number, level: number, text: string, detector: ProfileBlock["heading_detector"] = "style"): ProfileBlock => ({
  block_id: `B${String(n).padStart(4, "0")}`,
  kind: "heading",
  level,
  text,
  heading_detector: detector
})
const mapOf = (blocks: ProfileBlock[]) => Object.fromEntries(matchHeadings(blocks).map((h) => [h.heading_text, h]))

describe("matchHeadings — khớp gần, unmapped, ngưỡng 0.8", () => {
  it("heading tiếng Việt khớp alias của section cố định", () => {
    const map = mapOf([heading(1, 1, "2 Yêu cầu người dùng"), heading(2, 2, "2.1 Tác nhân"), heading(3, 1, "5 Phụ lục"), heading(4, 2, "5.5 Thuật ngữ")])
    expect(map["2 Yêu cầu người dùng"].section_id).toBe("group:2")
    expect(map["2.1 Tác nhân"]).toMatchObject({ section_id: "fixed:2.1", confidence: 1 })
    expect(map["5.5 Thuật ngữ"]).toMatchObject({ section_id: "fixed:5.5", confidence: 1 })
  })

  it("sai chính tả ⇒ vẫn khớp đúng section nhưng độ tin < 0.8 (cần xác nhận)", () => {
    const blocks = [heading(1, 1, "2 User Requirements"), heading(2, 2, "2.2 Use Cases"), heading(3, 3, "2.2.2 Use Case Descripton")]
    const h = mapOf(blocks)["2.2.2 Use Case Descripton"]
    expect(h.section_id).toBe("fixed:2.2.2")
    expect(h.confidence).toBeLessThan(MAPPING_CONFIDENCE_THRESHOLD)
    expect(h.confidence).toBeGreaterThanOrEqual(0.5)
    expect(needsMappingReview({ heading_map: matchHeadings(blocks), table_map: [] })).toBe(true)
  })

  it("khác số mục (đúng tiêu đề) ⇒ khớp theo tiêu đề, độ tin 0.7; không số mục ⇒ độ tin 1", () => {
    const map = mapOf([heading(1, 1, "4 Non-Functional Requirements"), heading(2, 2, "4.7 Quality Attributes"), heading(3, 3, "4.7.9 Performance")])
    expect(map["4.7.9 Performance"]).toMatchObject({ section_id: "fixed:4.2.3", confidence: 0.7 })
    expect(map["4.7 Quality Attributes"]).toMatchObject({ section_id: "group:4.2", confidence: 0.7 })
    expect(mapOf([heading(1, 1, "Performance")]).Performance).toMatchObject({ section_id: "fixed:4.2.3", confidence: 1 })
  })

  it("heading lạ ⇒ unmapped: không giống gì ⇒ độ tin 0.9 (không hỏi lại); giống yếu ⇒ 0.5 (hỏi lại)", () => {
    const map = mapOf([heading(1, 1, "9 Team Notes"), heading(2, 1, "Business Notes Draft")])
    expect(map["9 Team Notes"]).toMatchObject({ section_id: "unmapped", confidence: 0.9 })
    expect(map["Business Notes Draft"]).toMatchObject({ section_id: "unmapped", confidence: 0.5 })
  })

  it("mỗi section cố định nhận tối đa một heading: heading trùng thứ hai rơi về section cha/unmapped", () => {
    const hm = matchHeadings([heading(1, 1, "5.5 Glossary"), heading(2, 1, "Glossary")])
    expect(hm.filter((h) => h.section_id === "fixed:5.5")).toHaveLength(1)
    expect(hm.find((h) => h.heading_text === "5.5 Glossary")?.section_id).toBe("fixed:5.5")
  })

  it("con của section có nội dung ⇒ thuộc section cha, độ tin 0.8 (không cần xác nhận)", () => {
    const map = mapOf([heading(1, 1, "5 Requirement Appendix"), heading(2, 2, "5.1 Business Rules"), heading(3, 3, "5.1.1 Payment rules")])
    expect(map["5.1.1 Payment rules"]).toMatchObject({ section_id: "fixed:5.1", confidence: 0.8 })
  })

  it("ngưỡng 0.8: đúng 0.8 không cần xác nhận, dưới 0.8 cần, mục đã xác nhận thì bỏ qua", () => {
    const entry = (confidence: number, confirmed = false) => ({
      block_id: "B0001",
      heading_text: "x",
      section_id: "fixed:1",
      confidence,
      detected_by: "style" as const,
      confirmed
    })
    expect(needsMappingReview({ heading_map: [entry(0.8)], table_map: [] })).toBe(false)
    expect(needsMappingReview({ heading_map: [entry(0.79)], table_map: [] })).toBe(true)
    expect(needsMappingReview({ heading_map: [entry(0.3, true)], table_map: [] })).toBe(false)
    const column = { block_id: "B0002", column_index: 0, header: "Use Case ID", field_path: "use_cases[].id", confidence: 0.7, confirmed: false }
    expect(needsMappingReview({ heading_map: [], table_map: [column] })).toBe(true)
  })
})

describe("mẫu IEEE 830 + D6 (FLF-183)", () => {
  it("heading IEEE khớp section FPT qua alias; số mục khác FPT ⇒ độ tin thấp để người dùng xác nhận", () => {
    const map = mapOf([
      heading(1, 1, "1. Introduction"),
      heading(2, 2, "1.3 Definitions, acronyms & abbreviations"),
      heading(3, 1, "2. Overall description"),
      heading(4, 2, "2.3 User characteristics"),
      heading(5, 1, "3. Specific Requirements"),
      heading(6, 2, "3.3 Performance requirements"),
      heading(7, 2, "3.1 External interface requirements")
    ])
    expect(map["1.3 Definitions, acronyms & abbreviations"].section_id).toBe("fixed:5.5")
    expect(map["2.3 User characteristics"].section_id).toBe("fixed:2.1")
    expect(map["3. Specific Requirements"].section_id).toBe("group:3")
    expect(map["3.3 Performance requirements"].section_id).toBe("fixed:4.2.3")
    expect(map["3.3 Performance requirements"].confidence).toBeLessThan(MAPPING_CONFIDENCE_THRESHOLD)
    expect(map["3.1 External interface requirements"].section_id).toBe("fixed:4.1")
  })

  it("mọi đầu mục FPT (trừ Record of Changes tự sinh) là bắt buộc", () => {
    const missing = missingRequiredSections([])
    expect(missing).toContain("fixed:4.2.4")
    expect(missing).toContain("fixed:5.5")
    expect(missing).not.toContain("fixed:I")
    expect(missing).toHaveLength(19)
  })
})
