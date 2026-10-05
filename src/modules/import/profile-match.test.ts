import { describe, expect, it } from "vitest"
import { parseDocument } from "./parse.service.js"
import {
  assignBlockSections,
  detectTemplateFamily,
  matchHeadings,
  matchProfile,
  matchTables,
  missingRequiredSections,
  needsMappingReview,
  type ProfileBlock
} from "./profile-match.service.js"
import { MAPPING_CONFIDENCE_THRESHOLD } from "./import.constants.js"
import { makeSrsDocx } from "./testing/srs-fixture.js"
import { splitHeadingNumber, titleSimilarity } from "./text-similarity.js"
import { matchTable, matchTableHeader } from "./table-header-dictionary.js"

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

  const fields = (headers: string[], section: string | null) => matchTableHeader(headers, section).columns.map((c) => c.field_path)

  it("FLF-251: gán cột theo điểm cao nhất cả bảng — khớp đúng tên thắng khớp gần; cột ký hiệu # không khớp", () => {
    // trước đây "Message Type" (khớp gần "message") giành mất nội dung, cột "Content" thật bị bỏ
    expect(fields(["#", "Message Code", "Message Type", "Context", "Content"], "fixed:5.3")).toEqual([null, "messages[].code", null, null, "messages[].text"])
  })

  it("FLF-251: đủ các cột FlintFlow xuất ra ⇒ file xuất ra import lại không mất dữ liệu bảng", () => {
    expect(fields(["ID", "Name", "Kind", "Description"], "fixed:2.1")).toEqual(["actors[].id", "actors[].name", "actors[].kind", "actors[].description"])
    expect(fields(["ID", "Use Case", "Actors", "Use Case Description", "Includes", "Extends"], "fixed:2.2.2")).toEqual([
      "use_cases[].id",
      "use_cases[].name",
      "use_cases[].actor_ids",
      "use_cases[].description",
      "use_cases[].includes",
      "use_cases[].extends"
    ])
    expect(fields(["Feature", "Screen", "Description"], "fixed:3.1.2")).toEqual(["screens[].feature_id", "screens[].name", "screens[].description"])
    expect(fields(["Entity", "Description", "Relations"], "fixed:3.1.5")).toEqual(["entities[].name", "entities[].description", "entities[].relations"])
    expect(fields(["Statement", "Metric", "Threshold", "Priority"], "fixed:4.2.3")).toEqual(["nfrs[].statement", "nfrs[].metric", "nfrs[].threshold", "nfrs[].priority"])
    expect(fields(["Code", "Text", "Functions"], "fixed:5.3")).toEqual(["messages[].code", "messages[].text", "messages[].function_ids"])
    expect(fields(["Term", "Native", "Definition"], "fixed:5.5")).toEqual(["glossary[].term", "glossary[].term_native", "glossary[].definition"])
  })

  it("FLF-251: bảng chức năng không màn hình (3.1.4) ⇒ functions, không còn bị hiểu thành tác nhân / NFR", () => {
    expect(matchTableHeader(["Name", "Trigger", "Description"], "fixed:3.1.4")).toMatchObject({ entity: "functions" })
    expect(fields(["#", "Feature", "System Function", "Description"], "fixed:3.1.4")).toEqual([
      null,
      "functions[].feature_id",
      "functions[].name",
      "functions[].description"
    ])
  })

  it("FLF-251: section đã biết nhưng không phải section của thực thể ⇒ không đoán (để AI đọc)", () => {
    // ma trận phân quyền trông như bảng màn hình; bảng lịch sử thay đổi trông như NFR; bảng field trong mục chức năng trông như tác nhân
    expect(matchTableHeader(["Screen", "Guest", "User", "Admin"], "fixed:3.1.3").entity).toBeNull()
    expect(matchTableHeader(["Date", "Version", "A*, M, D", "In charge", "Change Description"], "fixed:I").entity).toBeNull()
    expect(matchTableHeader(["Field Name", "Type", "Description"], "function:@B0042").entity).toBeNull()
  })
})

describe("matchTable — khớp theo cả dữ liệu dưới tiêu đề (FLF-252)", () => {
  const paths = (rows: string[][], section: string | null) => matchTable(rows, section).columns.map((c) => c.field_path)

  it("cột '#' chứa mã ⇒ cột mã; cột 'ID' chỉ chứa số thứ tự ⇒ không dùng làm mã", () => {
    expect(paths([["#", "Business Rule"], ["BR-01", "Password ≥ 8 chars"], ["BR-02", "Lock after 5 tries"]], "fixed:5.1")).toEqual(["business_rules[].id", "business_rules[].statement"])
    expect(paths([["ID", "Actor", "Description"], ["1", "Guest", "Visitor"], ["2", "Admin", "Manager"]], "fixed:2.1")).toEqual([null, "actors[].name", "actors[].description"])
  })

  it("ma trận màn hình × vai trò ở mục phân quyền ⇒ permissions; cột ghi vai trò, độ tin đủ cao", () => {
    const m = matchTable([["Screen", "Guest", "User", "Admin"], ["PUBLIC SCREENS"], ["Landing Page", "X", "X", "X"], ["Sign Up", "X", "", ""]], "fixed:3.1.3")
    expect(m.entity).toBe("permissions")
    expect(m.columns.map((c) => [c.field_path, c.confidence])).toEqual([
      ["permissions[].screen_id", 0.9],
      ["permissions[].role_id", 0.9],
      ["permissions[].role_id", 0.9],
      ["permissions[].role_id", 0.9]
    ])
    // ma trận ở mục khác không phải phân quyền ⇒ không đoán
    expect(matchTable([["Screen", "Guest", "User"], ["Login", "X", "X"]], "fixed:3.1.2").entity).not.toBe("permissions")
    // cột "#" đứng trước tên màn (SRS thật) ⇒ bỏ cột số thứ tự
    expect(paths([["#", "Screen / Function", "Developer", "Admin"], ["1", "Login with GitHub", "X", "X"], ["2", "Repository List", "X", ""]], "fixed:3.1.3")).toEqual([
      null,
      "permissions[].screen_id",
      "permissions[].role_id",
      "permissions[].role_id"
    ])
  })

  it("bảng yêu cầu dưới mục tính năng (mẫu IEEE) ⇒ chức năng; bảng field trong mục chức năng vẫn không đoán", () => {
    expect(paths([["ID", "Requirement", "Priority", "Verification"], ["FR-001", "The system shall …", "Must", "Test"]], "feature:@B0099")).toEqual([
      "functions[].id",
      "functions[].description",
      "functions[].priority",
      null
    ])
    expect(matchTable([["Field Name", "Type", "Description"], ["Email", "text", "Login email"]], "function:@B0100").entity).toBeNull()
  })

  it("cột mang vai trò theo dữ liệu + giá trị mẫu cho bước xác nhận; chỉ có tiêu đề ⇒ không có", () => {
    const m = matchTable([["#", "Actor", "Description"], ["1", "Guest", "Visitor"], ["2", "Admin", "Manager"]], "fixed:2.1")
    expect(m.columns.map((c) => [c.role, c.samples])).toEqual([
      ["row_no", ["1", "2"]],
      ["name", ["Guest", "Admin"]],
      ["name", ["Visitor", "Manager"]]
    ])
    expect(matchTableHeader(["Actor", "Description"], "fixed:2.1").columns.every((c) => c.role === undefined && c.samples === undefined)).toBe(true)
  })
})

describe("matchTables (FLF-251)", () => {
  it("chỉ bảng ở section có trích mới cần map cột — bỏ bảng Record of Changes, bảng dưới heading nhóm / không khớp", () => {
    const tbl = (block_id: string, rows: string[][]): ProfileBlock => ({ block_id, kind: "table", level: null, text: "", rows })
    const blocks = [
      tbl("B0002", [["Date", "A*\nM, D", "In charge", "Change Description"], ["29/07/2026", "A", "QuynhTTN", "Added"]]),
      tbl("B0004", [["#", "Actor", "Description"], ["1", "Guest", "Visitor"]]),
      tbl("B0006", [["Project Name", "[Project Name]"]]),
      tbl("B0008", [["Feature", "Notes"]])
    ]
    const sections = new Map<string, string | null>([
      ["B0002", "fixed:I"],
      ["B0004", "fixed:2.1"],
      ["B0006", null],
      ["B0008", "feature:@B0007"]
    ])
    const map = matchTables(blocks, sections)
    // FLF-252: mục tính năng có trích (danh sách yêu cầu) ⇒ bảng của nó vào bước map, nhưng không đủ cột ⇒ không gán field
    expect([...new Set(map.map((t) => t.block_id))]).toEqual(["B0004", "B0008"])
    expect(map.filter((t) => t.block_id === "B0004").map((t) => t.field_path)).toEqual([null, "actors[].name", "actors[].description"])
    expect(map.filter((t) => t.block_id === "B0008").every((t) => t.field_path === null)).toBe(true)
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
  it("heading IEEE khớp section FPT; FLF-252: khớp theo danh mục IEEE nên số mục IEEE là đúng số ⇒ độ tin đủ", () => {
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
    expect(map["3.3 Performance requirements"].confidence).toBeGreaterThanOrEqual(MAPPING_CONFIDENCE_THRESHOLD)
    expect(map["3.1 External interface requirements"].section_id).toBe("fixed:4.1")
  })

  it("FLF-252: dàn mục IEEE 830 ⇒ nhận họ mẫu IEEE, mỗi mục trích vào đúng section FPT, mục chỉ có ở IEEE giữ nguyên văn — không còn dòng sai độ tin cao", () => {
    const outline = [
      "1. Introduction", "1.1. Purpose", "1.3. Definitions, acronyms & abbreviations", "1.4. References",
      "2. Overall description", "2.1. Product perspective", "2.1.3. Hardware interfaces", "2.3. User characteristics", "2.4. Constraints",
      "3. Specific Requirements", "3.1. External interface requirements", "3.1.1. User interfaces", "3.1.2. Hardware interfaces",
      "3.2. Specific requirements", "3.2.1. Sequence diagrams", "3.2.3. Register account", "3.3. Performance requirements",
      "3.4. Design constraints", "3.5. Software system attributes", "3.5.1. Reliability", "3.5.2. Availability", "3.5.4. Maintainability",
      "3.6. Other requirements", "4. Supporting information", "4.2. Appendixes"
    ]
    const blocks = outline.map((text, i) => heading(i + 1, text.split(" ")[0].replace(/\.$/, "").split(".").length, text))
    expect(detectTemplateFamily(blocks)).toBe("ieee830")
    const map = mapOf(blocks)
    const at = (t: string) => [map[t].section_id, map[t].confidence]
    expect(at("1.3. Definitions, acronyms & abbreviations")).toEqual(["fixed:5.5", 1])
    expect(at("1.4. References")).toEqual(["unmapped", 1])
    expect(map["1.4. References"].template_section).toBe("ieee830:1.4")
    expect(at("2.1.3. Hardware interfaces")).toEqual(["fixed:4.1", 1])
    expect(at("2.3. User characteristics")).toEqual(["fixed:2.1", 1])
    expect(at("3.1. External interface requirements")).toEqual(["fixed:4.1", 1])
    expect(at("3.1.1. User interfaces")).toEqual(["fixed:3.1.2", 1])
    expect(at("3.4. Design constraints")).toEqual(["fixed:4.2.4", 1])
    // nhiều mục IEEE cùng một section FPT
    expect(at("3.5.1. Reliability")).toEqual(["fixed:4.2.2", 1])
    expect(at("3.5.2. Availability")).toEqual(["fixed:4.2.2", 1])
    expect(at("3.5.4. Maintainability")).toEqual(["fixed:4.2.4", 1])
    expect(at("3.6. Other requirements")).toEqual(["fixed:5.4", 1])
    // chương yêu cầu chức năng ⇒ tính năng; mục con lạ ⇒ chức năng nhưng phải xác nhận
    expect(map["3.2. Specific requirements"].section_id).toMatch(/^feature:@B\d{4}$/)
    expect(map["3.2.1. Sequence diagrams"].section_id).toBe("fixed:2.2.2")
    expect(map["3.2.3. Register account"]).toMatchObject({ section_id: expect.stringMatching(/^function:@/), confidence: 0.75 })
    // không còn heading nào bị gán sai mà vẫn ≥ 0.8 (trước đây: interface ⇒ function 0.85, Design constraints ⇒ feature 0.85)
    expect(Object.values(map).filter((h) => /^(feature|function):@/.test(h.section_id) && h.confidence >= 0.8).map((h) => h.heading_text)).toEqual([
      "3.2. Specific requirements"
    ])
  })

  it("FLF-252: mẫu IEEE dạng System Features ⇒ chương tính năng, mục mô tả dưới tính năng thuộc tính năng (không thành chức năng)", () => {
    const outline: [number, string][] = [
      [1, "1 Introduction"], [2, "1.2 Document Conventions"], [2, "1.4 Product Scope"],
      [1, "2 Overall Description"], [2, "2.3 User Classes and Characteristics"], [2, "2.5 Design and Implementation Constraints"],
      [1, "3 External Interface Requirements"], [2, "3.1 User Interfaces"],
      [1, "4 System Features"], [2, "4.1 Course Enrollment"], [3, "4.1.1 Description and Priority"], [3, "4.1.3 Functional Requirements"],
      [2, "4.2 Grade Reports"], [3, "4.2.1 Description and Priority"],
      [1, "5 Other Nonfunctional Requirements"], [2, "5.1 Performance Requirements"], [2, "5.3 Security Requirements"]
    ]
    const blocks = outline.map(([level, text], i) => heading(i + 1, level, text))
    expect(detectTemplateFamily(blocks)).toBe("ieee_features")
    const map = mapOf(blocks)
    const enrollment = map["4.1 Course Enrollment"].section_id
    expect(enrollment).toMatch(/^feature:@/)
    expect(map["4.1.1 Description and Priority"].section_id).toBe(enrollment)
    expect(map["4.1.3 Functional Requirements"].section_id).toBe(enrollment)
    expect(map["4.2.1 Description and Priority"].section_id).toBe(map["4.2 Grade Reports"].section_id)
    expect(map["1.2 Document Conventions"].section_id).toBe("unmapped")
    expect(map["2.5 Design and Implementation Constraints"].section_id).toBe("fixed:4.2.4")
    expect(map["3.1 User Interfaces"].section_id).toBe("fixed:3.1.2")
    expect(map["5.3 Security Requirements"].section_id).toBe("fixed:4.2.4")
  })

  it("FLF-252: tài liệu FPT không bị nhận nhầm là IEEE; ít heading ⇒ khớp như FPT", async () => {
    const { blocks } = await parseDocument(await makeSrsDocx())
    expect(detectTemplateFamily(blocks)).toBe("fpt")
    expect(detectTemplateFamily([heading(1, 1, "1. Introduction"), heading(2, 2, "1.1 Purpose")])).toBe("fpt")
  })

  it("mọi đầu mục FPT (trừ Record of Changes tự sinh) là bắt buộc", () => {
    const missing = missingRequiredSections([])
    expect(missing).toContain("fixed:4.2.4")
    expect(missing).toContain("fixed:5.5")
    expect(missing).not.toContain("fixed:I")
    expect(missing).toHaveLength(19)
  })
})
