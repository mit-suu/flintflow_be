import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import mammoth from "mammoth"
import { HEADING_TABLE_SPACING, buildDocxFileName, writeDocx } from "./docx-writer.js"
import { makePng, readZipEntries, readZipText } from "./zip.test-helper.js"
import type { RenderedDocument } from "./rendered-document.types.js"

const sample = JSON.parse(
  readFileSync(new URL("../../../fixtures/rendered-document-sample.json", import.meta.url), "utf8")
) as RenderedDocument

const headerXml = (docx: Buffer) => {
  const entries = readZipEntries(docx)
  return [...entries.entries()]
    .filter(([name]) => /^word\/header\d*\.xml$/.test(name))
    .map(([, content]) => content.toString("utf8"))
    .join("\n")
}

const baseline = (): RenderedDocument => {
  const { watermark: _watermark, ...rest } = structuredClone(sample)
  return { ...rest, source: "baseline", version: "v1.0" }
}

describe("writeDocx — fixture Working Draft", () => {
  let docx: Buffer
  let documentXml: string

  beforeAll(async () => {
    docx = await writeDocx(sample)
    documentXml = readZipText(docx, "word/document.xml")
  })

  it("FLF-198: ô bảng có lề trong, chữ không dán vào khung", () => {
    // `tblCellMar` ở cấp bảng và `tcMar` ở từng ô — Word và LibreOffice mỗi bên đọc một chỗ
    expect(documentXml).toContain("<w:tblCellMar>")
    expect(documentXml).toContain("<w:tcMar>")
    const margin = (side: string): number[] =>
      [...documentXml.matchAll(new RegExp(`<w:${side} w:type="dxa" w:w="(\\d+)"\\s*/>`, "g"))].map((m) => Number(m[1]))
    expect(margin("left").some((value) => value >= 120), `lề trái ô: ${margin("left").join(",")}`).toBe(true)
    expect(margin("top").some((value) => value >= 80), `lề trên ô: ${margin("top").join(",")}`).toBe(true)
  })

  it("là file zip OOXML hợp lệ, mammoth đọc được", async () => {
    expect(docx.subarray(0, 2).toString("ascii")).toBe("PK")
    const entries = readZipEntries(docx)
    expect(entries.has("[Content_Types].xml")).toBe(true)

    const { value } = await mammoth.extractRawText({ buffer: docx })
    expect(value).toContain("Software Requirement Specification")
    expect(value).toContain("Enrolls in courses and completes lessons")
  })

  it("có heading 5 chương FPT ở cấp Heading1", () => {
    for (const title of [
      "1 Product Overview",
      "2 User Requirements",
      "3 Functional Requirements",
      "4 Non-Functional Requirements",
      "5 Requirement Appendix"
    ]) {
      expect(documentXml).toMatch(
        new RegExp(`<w:pStyle w:val="Heading1"/>.*?<w:t[^>]*>${title}</w:t>`)
      )
    }
    expect(documentXml).toMatch(/<w:pStyle w:val="Heading3"\/>.*?<w:t[^>]*>2\.2\.2 Use Case Descriptions<\/w:t>/)
  })

  it("trang bìa có tên, version, ngày và nhãn DRAFT trong document.xml", () => {
    expect(documentXml).toContain("Lumen Học Trực Tuyến")
    expect(documentXml).toContain("Version: v0.3")
    expect(documentXml).toContain("Date: 2026-09-14")
    expect(documentXml).toContain("WORKING DRAFT")
  })

  it("mục lục là field TOC cấp 1–3, bật updateFields", () => {
    expect(documentXml).toMatch(/<w:instrText[^>]*>TOC [^<]*\\o &quot;1-3&quot;<\/w:instrText>/)
    expect(readZipText(docx, "word/settings.xml")).toContain("w:updateFields")
  })

  it("watermark DRAFT xoay 45° màu bạc trong header (lặp mọi trang)", () => {
    const header = headerXml(docx)
    expect(header).toContain('string="DRAFT"')
    expect(header).toContain("rotation:315")
    expect(header).toContain('fillcolor="silver"')
    expect(readZipText(docx, "word/document.xml")).toMatch(/<w:headerReference w:type="default"/)
  })

  it("§I Record of Changes là bảng có border, đủ 3 dòng", () => {
    const start = documentXml.indexOf("I. Record of Changes")
    const tableXml = documentXml.slice(documentXml.indexOf("<w:tbl>", start), documentXml.indexOf("</w:tbl>", start))
    expect(start).toBeGreaterThan(-1)
    expect(tableXml).toContain("<w:tblBorders>")
    expect(tableXml.match(/<w:tr>|<w:tr /g)).toHaveLength(4) // header + 3
    expect(tableXml).toContain("Renamed actor Learner to Student")
  })

  it("draft in trạng thái cờ sau §I: cờ đỏ, số stale, waive", () => {
    const roc = documentXml.indexOf("I. Record of Changes")
    const status = documentXml.indexOf("Working Draft Status")
    const chapter1 = documentXml.indexOf("1 Product Overview</w:t>")
    expect(roc).toBeLessThan(status)
    expect(status).toBeLessThan(chapter1)
    expect(documentXml).toContain("Open red flags: 2")
    expect(documentXml).toContain("Stale sections: 1")
    expect(documentXml).toContain("NFR-P02 has no numeric threshold")
    expect(documentXml).toContain("No other requirements apply to Release 1.0 scope")
  })

  it("section stale và awaiting_reaccept có shading vàng và dòng ghi chú tại chỗ", () => {
    expect(documentXml).toContain("[STALE]")
    expect(documentXml).toContain("[AWAITING RE-ACCEPT]")
    expect(documentXml).toContain('w:fill="FFF2CC"')

    // section accepted không bị tô
    const overview = documentXml.slice(
      documentXml.indexOf("1 Product Overview</w:t>"),
      documentXml.indexOf("2 User Requirements</w:t>")
    )
    expect(overview).not.toContain("FFF2CC")
  })

  it("ảnh PNG được nhúng vào word/media", () => {
    const media = [...readZipEntries(docx).keys()].filter((name) => name.startsWith("word/media/") && !name.endsWith("/"))
    expect(media).toHaveLength(1)
    expect(documentXml).toContain("<w:drawing>")
    expect(documentXml).toContain("Figure 1. System Context Diagram")
  })

  it("core/custom properties mang dấu version và project id", () => {
    const core = readZipText(docx, "docProps/core.xml")
    const custom = readZipText(docx, "docProps/custom.xml")
    expect(core).toContain("<dc:title>Lumen Học Trực Tuyến - Software Requirement Specification</dc:title>")
    expect(core).toContain("<dc:subject>flintflow_version:v0.3</dc:subject>")
    expect(custom).toMatch(/name="flintflow_project_id"[^>]*>\s*<vt:lpwstr>650000000000000000000001<\/vt:lpwstr>/)
  })
})

describe("writeDocx — biến thể", () => {
  it("baseline: không watermark, không cờ đỏ, vẫn in danh sách waive", async () => {
    const docx = await writeDocx(baseline())
    const documentXml = readZipText(docx, "word/document.xml")

    expect(headerXml(docx)).not.toContain("v:textpath")
    expect(documentXml).not.toContain("WORKING DRAFT")
    expect(documentXml).not.toContain("NFR-P02 has no numeric threshold")
    expect(documentXml).toContain("Waived Flags")
  })

  it("ảnh rộng hơn trang được thu nhỏ theo chiều rộng, giữ tỉ lệ", async () => {
    const doc = structuredClone(sample)
    doc.sections = [{ id: "fixed:1", number: "1", heading: "Wide", level: 1, blocks: [{ type: "image", png: makePng(2000, 500) }] }]
    const xml = readZipText(await writeDocx(doc), "word/document.xml")
    const [, cx, cy] = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml) ?? []

    // 602 px × 9525 EMU/px
    expect(Number(cx)).toBe(602 * 9525)
    expect(Number(cy)).toBe(Math.round(500 * (602 / 2000)) * 9525)
  })

  it("ảnh nhỏ giữ nguyên kích thước, nhận Buffer và data URI", async () => {
    const png = makePng(100, 40)
    for (const value of [png, `data:image/png;base64,${png.toString("base64")}`]) {
      const doc = structuredClone(sample)
      doc.sections = [{ id: "fixed:1", number: "1", heading: "Small", level: 1, blocks: [{ type: "image", png: value }] }]
      const xml = readZipText(await writeDocx(doc), "word/document.xml")
      expect(xml).toContain(`<wp:extent cx="${100 * 9525}" cy="${40 * 9525}"`)
    }
  })

  it("ảnh không phải PNG ném RENDER_IMAGE_INVALID", async () => {
    const doc = structuredClone(sample)
    doc.sections = [{ id: "fixed:1", number: "1", heading: "Bad", level: 1, blocks: [{ type: "image", png: "bm90IGEgcG5n" }] }]
    await expect(writeDocx(doc)).rejects.toMatchObject({ statusCode: 422, code: "RENDER_IMAGE_INVALID" })
  })

  it("tiêu đề ngay trước bảng có khoảng trống phía dưới; tiêu đề trước đoạn văn thì không", async () => {
    const doc = structuredClone(sample)
    const tableBlock = { type: "table" as const, header: [[{ text: "H" }]], rows: [[[{ text: "v" }]]] }
    doc.sections = [
      { id: "fixed:2.1", number: "2.1", heading: "TableFirst", level: 2, blocks: [tableBlock] },
      { id: "fixed:2.2", number: "2.2", heading: "TextFirst", level: 2, blocks: [{ type: "paragraph", runs: [{ text: "p" }] }] },
      { id: "fixed:5.1", number: "5.1", heading: "Mixed", level: 2, blocks: [{ type: "heading", level: 3, text: "SubBeforeTable" }, tableBlock] }
    ]
    const xml = readZipText(await writeDocx(doc), "word/document.xml")
    const paragraphOf = (text: string) => [...xml.matchAll(/<w:p>(?:(?!<\/w:p>).)*<\/w:p>/gs)].map((m) => m[0]).find((p) => p.includes(`>${text}<`))!
    const spaced = `<w:spacing w:after="${HEADING_TABLE_SPACING}"/>`
    expect(paragraphOf("2.1 TableFirst")).toContain(spaced)
    expect(paragraphOf("SubBeforeTable")).toContain(spaced)
    expect(paragraphOf("2.2 TextFirst")).not.toContain(spaced)
    expect(paragraphOf("5.1 Mixed")).not.toContain(spaced)
  })

  it("mỗi numbered list đánh số lại từ đầu (instance riêng)", async () => {
    const doc = structuredClone(sample)
    const list = { type: "numbered_list" as const, items: [[{ text: "x" }], [{ text: "y" }]] }
    doc.sections = [{ id: "fixed:1", number: "1", heading: "Lists", level: 1, blocks: [list, list] }]
    const numbering = readZipText(await writeDocx(doc), "word/numbering.xml")
    const numIds = new Set(
      [...readZipText(await writeDocx(doc), "word/document.xml").matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1])
    )
    expect(numbering).toContain("<w:abstractNum")
    expect(numIds.size).toBe(2)
  })
})

describe("buildDocxFileName", () => {
  it("draft thêm -draft, bỏ dấu tiếng Việt", () => {
    expect(buildDocxFileName(sample)).toBe("lumen-hoc-truc-tuyen-v0.3-draft.docx")
  })

  it("baseline không có -draft; version conditional giữ nguyên", () => {
    expect(buildDocxFileName({ projectName: "Lumen", version: "v1.0-conditional", source: "baseline" })).toBe(
      "lumen-v1.0-conditional.docx"
    )
  })

  it("ký tự lạ thành gạch, không nhân đôi -draft, tên rỗng dùng srs", () => {
    expect(buildDocxFileName({ projectName: "Đường/Sắt: 2026!", version: "v 0.4", source: "draft" })).toBe(
      "duong-sat-2026-v-0.4-draft.docx"
    )
    expect(buildDocxFileName({ projectName: "!!!", version: "v0.4-draft", source: "draft" })).toBe("srs-v0.4-draft.docx")
  })
})

describe("writeDocx — phụ lục cờ theo ngôn ngữ (mode 1: tiếng Việt, không in mã luật)", () => {
  const withFlags = (): RenderedDocument => {
    const doc = structuredClone(sample)
    doc.flagsAppendix = {
      redOpen: [{ id: "FL001", rule_id: "section_empty", section: "5.5 Thuật ngữ", message: 'Mục bắt buộc "5.5 Glossary" chưa có dữ liệu' }],
      staleCount: 0,
      waived: []
    }
    return doc
  }

  it("flagLanguage vi ⇒ tiêu đề cột tiếng Việt + nhãn luật thay mã", async () => {
    const { value } = await mammoth.extractRawText({ buffer: await writeDocx(withFlags(), { flagLanguage: "vi" }) })
    expect(value).toContain("Lỗi đỏ đang mở")
    expect(value).toContain("Loại lỗi")
    expect(value).toContain("Mục còn trống")
    expect(value).not.toContain("section_empty")
    expect(value).not.toContain("Open Red Flags")
  })

  it("mặc định (mode 2) giữ nguyên tiếng Anh", async () => {
    const { value } = await mammoth.extractRawText({ buffer: await writeDocx(withFlags()) })
    expect(value).toContain("Open Red Flags")
    expect(value).toContain("section_empty")
  })
})
