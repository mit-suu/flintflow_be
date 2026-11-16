import { describe, expect, it } from "vitest"
import { Document, HeadingLevel, Packer, Paragraph } from "docx"
import { splitParagraphs } from "../document-paragraphs.js"
import { parseFileContent } from "../../utils/file-text.js"
import { alignOutline, extractDocxHeadings, headingsFromHtml, isDocx } from "./docx-outline.js"

describe("docx-outline (FLF-393)", () => {
  it("headingsFromHtml: bỏ thẻ con, giải entity, bỏ heading rỗng", () => {
    const html = '<h1><a id="_Toc1"></a>Use Case &amp; Actors</h1><p>thân</p><h2>Đặc tả <strong>use case</strong></h2><h3> </h3>'
    expect(headingsFromHtml(html)).toEqual([
      { level: 1, text: "Use Case & Actors" },
      { level: 2, text: "Đặc tả use case" }
    ])
  })

  it("alignOutline: khớp theo thứ tự, heading không có trong chữ bị bỏ qua", () => {
    const paragraphs = ["Bìa", "Giới thiệu", "nội dung", "Use Cases", "Giới thiệu", "nội dung khác"]
    const headings = [
      { level: 1, text: "Giới thiệu" },
      { level: 1, text: "Mục chỉ có trong bảng" },
      { level: 2, text: "Use Cases" }
    ]
    expect(alignOutline(paragraphs, headings)).toEqual([
      { p: 1, level: 1 },
      { p: 3, level: 2 }
    ])
  })

  it("isDocx", () => {
    expect(isDocx("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "")).toBe(true)
    expect(isDocx("application/octet-stream", ".DOCX")).toBe(true)
    expect(isDocx("application/pdf", ".pdf")).toBe(false)
  })

  it("file .docx thật: heading style khớp về đúng đoạn của extractedText", async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: "Yêu cầu người dùng", heading: HeadingLevel.HEADING_1 }),
            new Paragraph("Phần này mô tả tác nhân và ca sử dụng."),
            new Paragraph({ text: "Đặc tả use case", heading: HeadingLevel.HEADING_2 }),
            new Paragraph("UC-01 cho phép khách hàng đăng nhập.")
          ]
        }
      ]
    })
    const buffer = await Packer.toBuffer(doc)
    const { text } = await parseFileContent(buffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx")
    const headings = await extractDocxHeadings(buffer)
    expect(headings).toEqual([
      { level: 1, text: "Yêu cầu người dùng" },
      { level: 2, text: "Đặc tả use case" }
    ])
    expect(alignOutline(splitParagraphs(text), headings)).toEqual([
      { p: 0, level: 1 },
      { p: 2, level: 2 }
    ])
  })
})
