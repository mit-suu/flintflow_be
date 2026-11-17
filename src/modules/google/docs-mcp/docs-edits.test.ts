import { describe, expect, it } from "vitest"
import { parseDocument } from "./docs-structure.js"
import { planInsert, planReplace } from "./docs-edits.js"
import { loadSampleDoc } from "./docs-test-fixture.js"

const structure = parseDocument(loadSampleDoc())
const heading = (text: string) => structure.headings.find((h) => h.text === text)!

describe("planReplace", () => {
  it("đếm chỗ khớp + mẫu trước/sau kèm mục; request replaceAllText đúng matchCase", () => {
    const plan = planReplace(structure, "Đặt vé", "Mua vé", true)
    expect(plan.matches).toBe(2)
    expect(plan.samples[0]).toMatchObject({ heading: "2.1 Use cases" })
    expect(plan.samples[0].after).toContain("UC01 Mua vé")
    expect(plan.requests).toEqual([{ replaceAllText: { containsText: { text: "Đặt vé", matchCase: true }, replaceText: "Mua vé" } }])
  })

  it("matchCase false ⇒ khớp cả khác hoa thường; không khớp ⇒ 0", () => {
    expect(planReplace(structure, "đặt vé", "x", true).matches).toBe(0)
    expect(planReplace(structure, "đặt vé", "x", false).matches).toBe(2)
    expect(planReplace(structure, "không có", "x", true)).toMatchObject({ matches: 0, samples: [] })
  })
})

describe("planInsert", () => {
  it("cuối một mục ở giữa tài liệu ⇒ chèn 'chữ\\n' ngay trước heading kế tiếp, đặt lại kiểu chữ thường", () => {
    const plan = planInsert(structure, { afterHeading: "Business Rules" }, "BR02: Hoàn vé trước 24 giờ.", false)
    const next = heading("3. Appendix").startIndex
    expect(plan).toMatchObject({ location: "2.2 Business Rules", index: next, asHeading: false, headingLevel: null })
    expect(plan.requests[0]).toEqual({ insertText: { location: { index: next }, text: "BR02: Hoàn vé trước 24 giờ.\n" } })
    expect(plan.requests[1]).toMatchObject({
      updateParagraphStyle: { range: { startIndex: next, endIndex: next + "BR02: Hoàn vé trước 24 giờ.".length }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" } }
    })
    expect(plan.requests).toHaveLength(2)
  })

  it("asHeading ⇒ dòng đầu thành heading cấp con, các dòng sau chữ thường", () => {
    const text = "2.3 Payment\nThanh toán qua ví."
    const plan = planInsert(structure, { afterHeading: "Overall Description" }, text, true)
    const start = heading("3. Appendix").startIndex
    expect(plan.headingLevel).toBe(2)
    expect(plan.requests[2]).toEqual({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: start + "2.3 Payment".length },
        paragraphStyle: { namedStyleType: "HEADING_2" },
        fields: "namedStyleType"
      }
    })
  })

  it("mục cuối tài liệu hoặc atEnd ⇒ chèn '\\nchữ' trước ký tự xuống dòng cuối", () => {
    for (const target of [{ afterHeading: "Appendix" }, { atEnd: true as const }]) {
      const plan = planInsert(structure, target, "Phụ lục B.\n\n", false)
      expect(plan.index).toBe(structure.bodyEnd - 1)
      expect(plan.requests[0]).toEqual({ insertText: { location: { index: structure.bodyEnd - 1 }, text: "\nPhụ lục B." } })
      expect(plan.requests[1]).toMatchObject({ updateParagraphStyle: { range: { startIndex: structure.bodyEnd, endIndex: structure.bodyEnd + "Phụ lục B.".length } } })
    }
    expect(planInsert(structure, { atEnd: true }, "x", true).headingLevel).toBe(1)
  })

  it("chữ rỗng ⇒ TEXT_EMPTY; heading không thấy ⇒ HEADING_NOT_FOUND", () => {
    expect(() => planInsert(structure, { atEnd: true }, " \n ", false)).toThrow(expect.objectContaining({ code: "TEXT_EMPTY" }))
    expect(() => planInsert(structure, { afterHeading: "Glossary" }, "x", false)).toThrow(expect.objectContaining({ code: "HEADING_NOT_FOUND" }))
  })
})
