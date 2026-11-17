import { describe, expect, it } from "vitest"
import { DocsToolError, findHeading, outlineOf, parseDocument, searchText, sectionText } from "./docs-structure.js"
import { loadSampleDoc } from "./docs-test-fixture.js"

const structure = parseDocument(loadSampleDoc())

const lookupError = (query: string): DocsToolError => {
  try {
    findHeading(structure, query)
  } catch (err) {
    return err as DocsToolError
  }
  throw new Error("expected findHeading to throw")
}

describe("parseDocument / outlineOf", () => {
  it("mục lục: đủ heading theo thứ tự, cấp, revisionId; bỏ section break đầu tài liệu", () => {
    const outline = outlineOf(structure)
    expect(outline).toMatchObject({ documentId: "doc-srs-1", title: "SRS Ticket Booking", revisionId: "rev-1" })
    expect(outline.headings.map((h) => [h.level, h.text])).toEqual([
      [1, "1. Introduction"],
      [2, "1.1 Purpose"],
      [1, "2. Overall Description"],
      [2, "2.1 Use cases"],
      [2, "2.2 Business Rules"],
      [1, "3. Appendix"]
    ])
    expect(structure.blocks[0].startIndex).toBe(1)
    expect(structure.bodyEnd).toBe(319)
  })

  it("phạm vi mục: mục cấp 1 kéo tới heading cấp 1 kế tiếp; mục cuối kéo tới cuối thân tài liệu", () => {
    const [intro, purpose, overall, , rules, appendix] = structure.headings
    expect(intro.sectionEnd).toBe(overall.startIndex)
    expect(purpose.sectionEnd).toBe(overall.startIndex)
    expect(rules.sectionEnd).toBe(appendix.startIndex)
    expect(appendix.sectionEnd).toBe(structure.bodyEnd)
  })

  it("bảng thành chữ: ô cách nhau ' | ', hàng xuống dòng", () => {
    expect(structure.blocks.find((b) => b.kind === "table")?.text).toBe("ID | Name\nUC01 | Đặt vé")
  })
})

describe("findHeading", () => {
  it("khớp không phân biệt hoa thường, dấu, và bỏ qua số mục", () => {
    expect(findHeading(structure, "2.1 Use cases").text).toBe("2.1 Use cases")
    expect(findHeading(structure, "use CASES").text).toBe("2.1 Use cases")
    expect(findHeading(structure, "  business   rules ").text).toBe("2.2 Business Rules")
  })

  it("không thấy ⇒ HEADING_NOT_FOUND kèm danh sách heading", () => {
    const err = lookupError("Glossary")
    expect(err.code).toBe("HEADING_NOT_FOUND")
    expect(err.meta?.headings).toHaveLength(6)
  })

  it("nhiều mục cùng khớp ⇒ HEADING_AMBIGUOUS kèm các mục khớp", () => {
    const err = lookupError("u") // "Introduction", "Purpose", "Use cases", "Business Rules"…
    expect(err.code).toBe("HEADING_AMBIGUOUS")
    expect((err.meta?.candidates as unknown[]).length).toBeGreaterThan(1)
  })
})

describe("sectionText / searchText", () => {
  it("chữ của mục gồm cả mục con và bảng; cắt khi quá trần", () => {
    const overall = findHeading(structure, "Overall Description")
    const full = sectionText(structure, overall, 10_000)
    expect(full.text).toContain("UC01 Đặt vé: khách hàng")
    expect(full.text).toContain("ID | Name")
    expect(full.text).toContain("BR01: Mỗi khách")
    expect(full.text).not.toContain("Contact: support team.")
    expect(full.truncated).toBe(false)

    const cut = sectionText(structure, overall, 20)
    expect(cut).toMatchObject({ truncated: true, totalChars: full.totalChars })
    expect(cut.text).toHaveLength(20)
  })

  it("tìm không phân biệt dấu, kèm heading chứa đoạn khớp", () => {
    const result = searchText(structure, "dat ve", 20)
    expect(result.total).toBe(2) // đoạn UC01 + bảng
    expect(result.matches[0]).toMatchObject({ heading: "2.1 Use cases" })
    expect(result.matches[0].snippet).toContain("Đặt vé")
    expect(searchText(structure, "dat ve", 1).matches).toHaveLength(1)
  })
})
