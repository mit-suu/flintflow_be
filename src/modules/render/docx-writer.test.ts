import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import mammoth from "mammoth"
import { HEADING_TABLE_SPACING, buildDocxFileName, exportLineage, writeDocx } from "./docx-writer.js"
import { makePng, readZipEntries, readZipText } from "./zip.test-helper.js"
import type { RenderedDocument } from "./rendered-document.types.js"
import { DocxPackage, readBlocks } from "../docx-ooxml/index.js"

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

describe("writeDocx - fixture Working Draft", () => {
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

  it("FLF-316: Heading 1–3 mang outlineLvl - LibreOffice (bản PDF) dựng mục lục theo cấp outline, không theo tên style", () => {
    const stylesXml = readZipText(docx, "word/styles.xml")
    for (const level of [1, 2, 3]) {
      const style = new RegExp(`<w:style[^>]*w:styleId="Heading${level}".*?</w:style>`, "s").exec(stylesXml)?.[0]
      expect(style, `Heading${level}`).toContain(`<w:outlineLvl w:val="${level - 1}"/>`)
    }
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
    // FLF-334: bản nháp "v0.3" (gốc 0.x) ⇒ loại draft, không CR; FLF-356: gốc giữ đúng số 0.3, không gộp về 0
    expect(custom).toMatch(/name="flintflow_base_version"[^>]*>\s*<vt:lpwstr>0.3<\/vt:lpwstr>/)
    expect(custom).toMatch(/name="flintflow_kind"[^>]*>\s*<vt:lpwstr>draft<\/vt:lpwstr>/)
    expect(custom).not.toContain("flintflow_latest_cr")
  })
})

describe("writeDocx - biến thể", () => {
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

  it("sơ đồ vẽ lỗi (marker diagram-error:<id>) ⇒ nhúng ảnh placeholder kèm chú thích, không ném lỗi", async () => {
    const doc = structuredClone(sample)
    doc.sections = [{ id: "fixed:1", number: "1", heading: "Failed", level: 1, blocks: [{ type: "image", png: "diagram-error:D07", caption: "Class Diagram - diagram could not be drawn yet" }] }]
    const docx = await writeDocx(doc)
    expect([...readZipEntries(docx).keys()].some((name) => name.startsWith("word/media/"))).toBe(true)
    expect(readZipText(docx, "word/document.xml")).toContain("Class Diagram - diagram could not be drawn yet")
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

describe("buildDocxFileName - quy tắc chung FLF-334", () => {
  it("bản nháp: gốc baseline (+ N changes bỏ đi) ⇒ _v<gốc>_DRAFT; chưa baseline (v0) ⇒ <tên>_DRAFT", () => {
    expect(buildDocxFileName({ projectName: "Lumen", version: "v1.0 + 3 changes", source: "draft" })).toBe("Lumen_v1.0_DRAFT.docx")
    expect(buildDocxFileName({ projectName: "Lumen", version: "v1.0", source: "draft" })).toBe("Lumen_v1.0_DRAFT.docx")
    expect(buildDocxFileName({ projectName: "Lumen", version: "v0", source: "draft" })).toBe("Lumen_DRAFT.docx")
    expect(buildDocxFileName(sample)).toBe(`Lumen Học Trực Tuyến_v${sample.version.replace(/^v/, "")}_DRAFT.docx`)
  })

  it("baseline ⇒ _v<version>, không _DRAFT; version conditional giữ nguyên", () => {
    expect(buildDocxFileName({ projectName: "Lumen", version: "v1.0", source: "baseline" })).toBe("Lumen_v1.0.docx")
    expect(buildDocxFileName({ projectName: "Lumen", version: "v1.0-conditional", source: "baseline" })).toBe("Lumen_v1.0-conditional.docx")
  })

  it("ký tự cấm của Windows thành gạch dưới, tên rỗng dùng SRS", () => {
    expect(buildDocxFileName({ projectName: "Đường/Sắt: 2026!", version: "v1.1", source: "baseline" })).toBe("Đường_Sắt_ 2026!_v1.1.docx")
    expect(buildDocxFileName({ projectName: "  ", version: "v0", source: "draft" })).toBe("SRS_DRAFT.docx")
  })

  it("exportLineage: gốc 0.x của dự án import giữ đúng số bản import (FLF-356)", () => {
    expect(exportLineage({ version: "0.1 + 2 changes", source: "draft" })).toEqual({ release: false, base: "0.1" })
    expect(exportLineage({ version: "0.0", source: "draft" })).toEqual({ release: false, base: "0.0" })
    expect(exportLineage({ version: "v1.1", source: "baseline" })).toEqual({ release: true, base: "1.1" })
  })

  it("FLF-356: dự án import 0.1 - draft ⇒ _v0.1_DRAFT, baseline (không watermark) ⇒ _v0.1; stamp kind vẫn draft", async () => {
    expect(exportLineage({ version: "0.1", source: "baseline" })).toEqual({ release: false, base: "0.1" })
    expect(buildDocxFileName({ projectName: "FAP", version: "0.1", source: "baseline" })).toBe("FAP_v0.1.docx")
    expect(buildDocxFileName({ projectName: "FAP", version: "0.1", source: "draft" })).toBe("FAP_v0.1_DRAFT.docx")
    expect(buildDocxFileName({ projectName: "FAP", version: "0.1 + 1 change", source: "draft" })).toBe("FAP_v0.1_DRAFT.docx")
    const custom = readZipText(await writeDocx({ ...baseline(), version: "0.1" }), "docProps/custom.xml")
    expect(custom).toMatch(/name="flintflow_kind"[^>]*>\s*<vt:lpwstr>draft<\/vt:lpwstr>/)
    expect(custom).toMatch(/name="flintflow_base_version"[^>]*>\s*<vt:lpwstr>0.1<\/vt:lpwstr>/)
  })
})

describe("style heading con theo mẫu FPT (FLF-214)", () => {
  const heading4 = async (doc: RenderedDocument) =>
    /<w:style [^>]*w:styleId="Heading4"[\s\S]*?<\/w:style>/.exec(readZipText(await writeDocx(doc), "word/styles.xml"))?.[0] ?? ""

  it("format fpt ⇒ Heading 4 là 12pt đậm (nhỏ hơn Heading 3 13pt); không đặt ⇒ giữ style mặc định như cũ", async () => {
    const fpt = await heading4({ ...structuredClone(sample), format: "fpt" })
    expect(fpt).toContain('<w:sz w:val="24"/>')
    expect(fpt).toContain("<w:b/>")
    expect(fpt).not.toContain("<w:color")

    const mode1 = await heading4(structuredClone(sample))
    expect(mode1).not.toContain('<w:sz w:val="24"/>')
  })
})

describe("writeDocx - phụ lục cờ theo ngôn ngữ (mode 1: tiếng Việt, không in mã luật)", () => {
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

describe("writeDocx - chữ cố định theo ngôn ngữ (FLF-265)", () => {
  const coreXml = (docx: Buffer) => readZipText(docx, "docProps/core.xml")
  const footerXml = (docx: Buffer) =>
    [...readZipEntries(docx).entries()]
      .filter(([name]) => /^word\/footer\d*\.xml$/.test(name))
      .map(([, content]) => content.toString("utf8"))
      .join("\n")

  it("language vi ⇒ bìa, mục lục, §I, ghi chú STALE / chờ chấp nhận lại, footer, core properties tiếng Việt", async () => {
    const docx = await writeDocx(sample, { language: "vi" })
    const xml = readZipText(docx, "word/document.xml")
    for (const text of [
      "Đặc tả yêu cầu phần mềm",
      `Phiên bản: ${sample.version}`,
      `Ngày: ${sample.generatedAt.slice(0, 10)}`,
      "BẢN LÀM VIỆC - CHƯA BASELINE",
      "Mục lục",
      "I. Lịch sử thay đổi",
      "*A - Thêm, M - Sửa, D - Xoá",
      "Người thực hiện",
      "Mô tả thay đổi",
      "[CẦN XEM LẠI]",
      "[CHỜ CHẤP NHẬN LẠI]"
    ]) {
      expect(xml, text).toContain(text)
    }
    // Định nghĩa thuật ngữ "SRS" trong mẫu chứa cụm này (nội dung, không phải nhãn) ⇒ so đúng run của bìa
    expect(xml).not.toContain(">Software Requirement Specification</w:t>")
    for (const text of ["Table of Contents", "Record of Changes", "Change Description", "[STALE]", "[AWAITING RE-ACCEPT]", "WORKING DRAFT"]) {
      expect(xml, text).not.toContain(text)
    }
    expect(footerXml(docx)).toContain("Trang ")
    expect(footerXml(docx)).not.toContain("Page ")
    expect(coreXml(docx)).toContain(`${sample.projectName} - Đặc tả yêu cầu phần mềm`)
    expect(coreXml(docx)).toContain(`Bản làm việc ${sample.version}`)
    expect(headerXml(docx)).toContain(`${sample.projectName} - SRS ${sample.version}`)
  })

  it("language vi không đổi phụ lục cờ - phụ lục vẫn theo flagLanguage", async () => {
    const { value } = await mammoth.extractRawText({ buffer: await writeDocx(sample, { language: "vi" }) })
    expect(value).toContain("Working Draft Status")
  })

  it("mặc định = language en: document.xml, header, footer y hệt nhau", async () => {
    const [plain, en] = await Promise.all([writeDocx(sample), writeDocx(sample, { language: "en" })])
    expect(readZipText(en, "word/document.xml")).toBe(readZipText(plain, "word/document.xml"))
    expect(headerXml(en)).toBe(headerXml(plain))
    expect(footerXml(en)).toBe(footerXml(plain))
    expect(readZipText(plain, "word/document.xml")).toContain("Table of Contents")
    expect(readZipText(plain, "word/document.xml")).toContain(">Software Requirement Specification</w:t>")
    expect(footerXml(plain)).toContain("Page ")
  })

  it("baseline vi ⇒ băng rôn BASELINE, mô tả core 'Baseline'", async () => {
    const docx = await writeDocx(baseline(), { language: "vi" })
    expect(readZipText(docx, "word/document.xml")).toContain("BASELINE")
    expect(coreXml(docx)).toContain("Baseline v1.0 tạo lúc")
  })
})

describe("writeDocx - mục lục ghi sẵn cho file version mode 1 (FLF-344)", () => {
  /** Tài liệu theo layout file khách: phần La Mã cấp 1, chương cấp 2, mục cấp 3, mục con cấp 4 + heading trong khối. */
  const layoutDoc = (): RenderedDocument => ({
    projectId: "p1",
    projectName: "Report 3",
    version: "0.1",
    source: "baseline",
    generatedAt: "2026-11-02T00:00:00.000Z",
    recordOfChanges: [],
    sections: [
      { id: "group:II", number: "II", heading: "Software Requirement Specification", level: 1, blocks: [] },
      { id: "fixed:1", number: "1", heading: "Product Overview", level: 2, blocks: [{ type: "paragraph", runs: [{ text: "Tổng quan." }] }] },
      {
        id: "fixed:3.1.2",
        number: "1.1",
        heading: "Screen Flow",
        level: 3,
        blocks: [
          { type: "heading", level: 3, text: "Screen Descriptions" },
          { type: "heading", level: 4, text: "Login" },
          { type: "paragraph", runs: [{ text: "Đăng nhập." }] }
        ]
      },
      { id: "function:FN1", number: "1.1.1", heading: "Create Project", level: 4, blocks: [] }
    ]
  })

  const tocSdt = (xml: string): string => /<w:sdt>[\s\S]*?<\/w:sdt>/.exec(xml)?.[0] ?? ""
  const tocLines = (xml: string): string[] =>
    [...tocSdt(xml).matchAll(/<w:hyperlink [^>]*w:anchor="([^"]+)"[\s\S]*?<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => `${m[1]}|${m[2]}`)

  it("tái hiện: mặc định (export mode 2) field TOC rỗng, không có dòng nào", async () => {
    const xml = readZipText(await writeDocx(layoutDoc()), "word/document.xml")
    expect(tocSdt(xml)).toMatch(/TOC [^<]*\\o &quot;1-3&quot;/)
    expect(tocLines(xml)).toEqual([])
    expect(xml).not.toContain("_Toc")
  })

  it("tocEntries ⇒ mỗi heading cấp 1–3 một dòng mục lục theo thứ tự tài liệu, cấp 4+ không vào", async () => {
    const xml = readZipText(await writeDocx(layoutDoc(), { flagLanguage: "vi", tocEntries: true }), "word/document.xml")
    const lines = tocLines(xml)
    expect(lines.map((l) => l.split("|")[1])).toEqual([
      "I. Record of Changes",
      "II Software Requirement Specification",
      "1 Product Overview",
      "1.1 Screen Flow",
      "Screen Descriptions"
    ])
    expect(lines.join("\n")).not.toContain("Create Project")
    expect(lines.join("\n")).not.toContain("Login")
    // cấp của dòng = cấp heading: style TOC1/TOC2/TOC3
    expect([...tocSdt(xml).matchAll(/<w:pStyle w:val="(TOC\d)"\/>/g)].map((m) => m[1])).toEqual(["TOC1", "TOC1", "TOC2", "TOC3", "TOC3"])
    // field TOC vẫn còn (Word / LibreOffice cập nhật lại kèm số trang), vẫn bật updateFields
    expect(tocSdt(xml)).toMatch(/TOC [^<]*\\o &quot;1-3&quot;/)
    expect(tocSdt(xml)).toContain('w:fldCharType="end"')
  })

  it("tocEntries ⇒ khai style toc 1–3 (tên chuẩn của Word) thụt lề theo cấp; mặc định không thêm style", async () => {
    const styles = readZipText(await writeDocx(layoutDoc(), { tocEntries: true }), "word/styles.xml")
    for (const [level, indent] of [[1, 0], [2, 240], [3, 480]] as const) {
      const style = new RegExp(`<w:style [^>]*w:styleId="TOC${level}"[\\s\\S]*?</w:style>`).exec(styles)?.[0] ?? ""
      expect(style, `TOC${level}`).toContain(`<w:name w:val="toc ${level}"/>`)
      expect(style).toMatch(new RegExp(`<w:ind [^>]*w:left="${indent}"`))
    }
    expect(readZipText(await writeDocx(layoutDoc()), "word/styles.xml")).not.toContain('w:styleId="TOC1"')
  })

  it("tocEntries ⇒ mỗi dòng mục lục trỏ tới bookmark bọc đúng heading (bấm được tới mục)", async () => {
    const xml = readZipText(await writeDocx(layoutDoc(), { tocEntries: true }), "word/document.xml")
    const body = xml.slice(xml.indexOf("</w:sdt>"))
    for (const line of tocLines(xml)) {
      const [anchor, title] = line.split("|")
      const start = new RegExp(`<w:bookmarkStart w:name="${anchor}" w:id="(\\d+)"/>`).exec(body)
      expect(start, `bookmark ${anchor}`).not.toBeNull()
      const after = body.slice(start!.index)
      expect(after.slice(0, after.indexOf(`<w:bookmarkEnd w:id="${start![1]}"/>`))).toContain(`>${title}</w:t>`)
    }
  })

  it("tocEntries ⇒ heading vẫn mang style Heading 1–3 có outlineLvl (bản PDF / bookmark PDF dựng theo cấp outline)", async () => {
    const docx = await writeDocx(layoutDoc(), { tocEntries: true })
    const xml = readZipText(docx, "word/document.xml")
    expect(xml).toMatch(/<w:pStyle w:val="Heading2"\/>[\s\S]*?<w:bookmarkStart [^>]*\/>[\s\S]*?>1 Product Overview<\/w:t>/)
    const styles = readZipText(docx, "word/styles.xml")
    for (const [id, lvl] of [["Heading1", 0], ["Heading2", 1], ["Heading3", 2]] as const) {
      expect(new RegExp(`w:styleId="${id}"[\\s\\S]*?<w:outlineLvl w:val="${lvl}"/>`).test(styles), id).toBe(true)
    }
  })

  it("upload lại file đã xuất: dòng mục lục ghi sẵn không thành nội dung, heading vẫn nhận đúng cấp", async () => {
    const pkg = await DocxPackage.load(await writeDocx(layoutDoc(), { tocEntries: true }))
    const blocks = await readBlocks(pkg)
    const texts = blocks.map((b) => b.text)
    expect(texts.filter((t) => t === "1 Product Overview")).toHaveLength(1)
    expect(texts.filter((t) => t === "Screen Descriptions")).toHaveLength(1)
    expect(blocks.find((b) => b.text === "1 Product Overview")).toMatchObject({ kind: "heading", level: 2 })
  })

  it("mode 2 (không bật) giữ nguyên document.xml", async () => {
    const plain = readZipText(await writeDocx(structuredClone(sample)), "word/document.xml")
    const explicit = readZipText(await writeDocx(structuredClone(sample), { tocEntries: false }), "word/document.xml")
    expect(explicit).toBe(plain)
  })
})
