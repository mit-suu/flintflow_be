import JSZip from "jszip"
import { XMLSerializer } from "@xmldom/xmldom"
import { describe, expect, it } from "vitest"
import { DocxPackage, readStamp } from "../docx-ooxml/index.js"
import { NS, wAll, wAttr, wKid, wKids } from "../docx-ooxml/xml.js"
import { parseDocument } from "../import/parse.service.js"
import type { RenderedDocument } from "./rendered-document.types.js"
import { isFrameHeading, writeTemplateDocx } from "./template-docx-writer.js"

const styles = `<w:styles xmlns:w="${NS.w}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`
const heading = (text: string, level = 1) => `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/><w:keepNext/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${text}</w:t></w:r></w:p>`
const body = `<w:p><w:pPr><w:spacing w:after="321"/><w:ind w:left="432"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Cambria"/><w:sz w:val="23"/></w:rPr><w:t>Replace this guidance.</w:t></w:r></w:p>`
const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:fill="AABBCC"/></w:tcPr>${body.replace("Replace this guidance.", text)}</w:tc>`
const sourceTable = `<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblBorders><w:top w:val="double"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("A")}${cell("B")}</w:tr><w:tr><w:trPr><w:trHeight w:val="444"/></w:trPr>${cell("sample")}${cell("sample")}</w:tr></w:tbl>`
async function template(table = sourceTable) {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<Types xmlns="${NS.ct}"><Default Extension="xml" ContentType="application/xml"/></Types>`)
  zip.file("word/document.xml", `<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>[Project</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t> name] - [Version] - [Date]</w:t></w:r></w:p>${heading("Requirements")}${body}${table}<w:p><w:r><w:br w:type="page"/></w:r></w:p>${heading("Repeated", 2)}${body}${heading("Repeated", 2)}${body}${heading("Unmapped")}${body}<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:pgMar w:top="1134" w:left="1134"/></w:sectPr></w:body></w:document>`)
  zip.file("word/styles.xml", styles)
  zip.file("word/numbering.xml", `<w:numbering xmlns:w="${NS.w}" />`)
  zip.file("word/header1.xml", `<w:hdr xmlns:w="${NS.w}"><w:p><w:r><w:t>Company header</w:t></w:r></w:p></w:hdr>`)
  zip.file("word/footer1.xml", `<w:ftr xmlns:w="${NS.w}"><w:p/></w:ftr>`)
  zip.file("word/theme/theme1.xml", "<theme/>")
  zip.file("word/media/flintflow1.png", Buffer.from("original image"))
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="${NS.rels}"><Relationship Id="rId1" Type="${NS.r}/header" Target="header1.xml"/><Relationship Id="rIdFF1" Type="${NS.r}/image" Target="media/flintflow1.png"/></Relationships>`)
  return zip.generateAsync({ type: "nodebuffer" })
}
const document = (): RenderedDocument => ({ projectId: "project", projectName: "Club Manager", version: "v0", source: "draft", generatedAt: "2026-11-04T00:00:00Z", recordOfChanges: [], sections: [] })
const runs = (text: string) => [{ text }]
const serializeXml = (node: Node) => new XMLSerializer().serializeToString(node)

describe("writeTemplateDocx", () => {
  it("replaces instruction-only overrides with the source body style", async () => {
    const zip = await JSZip.loadAsync(await template())
    zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace(body, body.replace("Replace this guidance.", "[Describe the requirements]").replace('<w:sz w:val="23"/>', '<w:sz w:val="23"/><w:i/><w:color w:val="7F7F7F"/>')))
    zip.file("word/styles.xml", styles.replace("</w:styles>", '<w:style w:type="paragraph" w:default="1" w:styleId="Body"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:style></w:styles>'))
    const input = await zip.generateAsync({ type: "nodebuffer" }), parsed = await parseDocument(input), doc = document()
    doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [{ type: "paragraph", runs: runs("Actual requirement") }] }]
    const output = await parseDocument(await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]))
    const paragraph = output.blocks.find((b) => b.text === "Actual requirement")!.element
    expect(wAttr(wKid(wKid(paragraph, "pPr")!, "pStyle"), "val")).toBe("Body")
    expect(wAll(paragraph, "i")).toHaveLength(0)
    expect(wAll(paragraph, "color")).toHaveLength(0)
    expect(wAttr(wKid(wKid(paragraph, "pPr")!, "spacing"), "after")).toBe("321")
    // A paragraph-only edit must not delete the source table in the same slot.
    expect(output.blocks.filter((b) => b.kind === "table").map((b) => b.rows)).toEqual(parsed.blocks.filter((b) => b.kind === "table").map((b) => b.rows))
  })

  it("preserves horizontal merged grid cells instead of cloning extra physical cells", async () => {
    const zip = await JSZip.loadAsync(await template())
    const merged = `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="3000"/>'.repeat(3)}</w:tblGrid><w:tr>${cell("A")}${cell("B")}${cell("C")}</w:tr><w:tr>${cell("[AB]").replace("<w:tcPr>", '<w:tcPr><w:gridSpan w:val="2"/>')}${cell("[C]")}</w:tr></w:tbl>`
    zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace(sourceTable, merged))
    const input = await zip.generateAsync({ type: "nodebuffer" }), parsed = await parseDocument(input), doc = document()
    doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [{ type: "table", header: [runs("A"), runs("B"), runs("C")], rows: [[runs("one"), runs("two"), runs("three")]] }] }]
    const output = await parseDocument(await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]))
    const table = output.blocks.find((b) => b.kind === "table")!.element
    const dataCells = wKids(wKids(table, "tr")[1], "tc")
    expect(dataCells).toHaveLength(2)
    expect(wAttr(wAll(dataCells[0], "gridSpan")[0], "val")).toBe("2")
    expect(wAll(dataCells[0], "t").map((t) => t.textContent).join(" ").replace(/\s+/g, " ").trim()).toBe("one two")
    expect(wAll(dataCells[1], "t").map((t) => t.textContent).join("")).toBe("three")
  })

  it("preserves vertical merge groups; hidden values / repeated continuations fall back to a FlintFlow table (FLF-372)", async () => {
    const zip = await JSZip.loadAsync(await template())
    const merged = sourceTable.replace(`${cell("sample")}${cell("sample")}</w:tr>`, `${cell("[A]").replace("<w:tcPr>", '<w:tcPr><w:vMerge w:val="restart"/>')}${cell("[B]")}</w:tr><w:tr>${cell("").replace("<w:tcPr>", '<w:tcPr><w:vMerge/>')}${cell("[B]")}</w:tr>`)
    zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace(sourceTable, merged))
    const input = await zip.generateAsync({ type: "nodebuffer" }), parsed = await parseDocument(input), doc = document()
    const block = { type: "table" as const, header: [runs("A"), runs("B")], rows: [[runs("group"), runs("first")], [runs(""), runs("second")]] }
    doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [block] }]
    const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
    const output = await parseDocument(await writeTemplateDocx(doc, input, map))
    const merges = wAll(output.blocks.find((b) => b.kind === "table")!.element, "vMerge")
    expect(merges.map((m) => wAttr(m, "val"))).toEqual(["restart", null])
    // FLF-372: không lặp được nhóm gộp dọc ⇒ không hỏng cả lượt — in bảng FlintFlow (không gộp), giá trị không mất
    block.rows[1][0] = runs("must not disappear")
    const fallback = (await parseDocument(await writeTemplateDocx(doc, input, map))).blocks.find((b) => b.kind === "table")!
    expect(wAll(fallback.element, "vMerge")).toHaveLength(0)
    expect(fallback.text).toContain("must not disappear")
    block.rows.pop()
    const single = (await parseDocument(await writeTemplateDocx(doc, input, map))).blocks.find((b) => b.kind === "table")!
    expect(wAll(single.element, "vMerge")).toHaveLength(0)
  })

  it("FLF-372: mục có ảnh gốc (sơ đồ) thay được khi bản in của mục mang lại ảnh - ảnh không mất", async () => {
    const zip = await JSZip.loadAsync(await template())
    zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace(body, `<w:p><w:r><w:drawing/></w:r></w:p>${body}`))
    const input = await zip.generateAsync({ type: "nodebuffer" }), parsed = await parseDocument(input), doc = document()
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
    doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [{ type: "paragraph", runs: runs("Context") }, { type: "image", png, caption: "Context diagram" }] }]
    const output = await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }])
    const reread = await parseDocument(output)
    expect(reread.blocks.filter((b) => b.kind === "image")).toHaveLength(1)
    expect(reread.blocks.some((b) => b.text === "Context")).toBe(true)
  })

  it.each([
    '<w:p><w:r><w:drawing/></w:r></w:p>',
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p>',
    `${body}<w:p><w:pPr><w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr></w:p>${body}`
  ])("refuses to delete source objects or move internal section boundaries", async (preserved) => {
    const zip = await JSZip.loadAsync(await template())
    zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace(body, preserved + body))
    const input = await zip.generateAsync({ type: "nodebuffer" }), parsed = await parseDocument(input), doc = document()
    doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [{ type: "paragraph", runs: runs("New text") }] }]
    await expect(writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }])).rejects.toMatchObject({ code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
  })

  it("retains original package layout and heading names, fills body/table patterns and split cover tokens", async () => {
    const input = await template(), parsed = await parseDocument(input)
    const headings = parsed.blocks.filter((b) => b.kind === "heading")
    const doc = document()
    doc.sections = [
      { id: "fixed:1", number: "1", heading: "Changed title must not replace original", level: 1, blocks: [{ type: "paragraph", runs: runs("Generated introduction.") }, { type: "table", header: [runs("A"), runs("B")], rows: [[runs("User"), runs("Admin")], [runs("Club"), runs("Active")]] }] },
      { id: "fixed:1.1", number: "1.1", heading: "First", level: 2, blocks: [] },
      { id: "fixed:1.2", number: "1.2", heading: "Second", level: 2, blocks: [{ type: "paragraph", runs: runs("Only second occurrence changes.") }] }
    ]
    const output = await writeTemplateDocx(doc, input, headings.slice(0, 3).map((h, i) => ({ block_id: h.block_id, section_id: doc.sections[i].id })))
    const originalZip = await JSZip.loadAsync(input), resultZip = await JSZip.loadAsync(output)
    for (const name of ["word/styles.xml", "word/numbering.xml", "word/header1.xml", "word/footer1.xml", "word/theme/theme1.xml", "word/media/flintflow1.png"]) expect(await resultZip.file(name)!.async("nodebuffer")).toEqual(await originalZip.file(name)!.async("nodebuffer"))
    const result = await DocxPackage.load(output), xml = await result.requireXml("word/document.xml")
    expect(wAll(xml, "t").map((t) => t.textContent).join("")).toContain("Club Manager - v0 - 2026-11-04")
    expect(wAll(xml, "t").map((t) => t.textContent).join("")).not.toContain("Changed title")
    expect(wAll(xml, "pgMar")[0].getAttributeNS(NS.w, "left")).toBe("1134")
    expect(wAll(xml, "br").filter((b) => wAttr(b, "type") === "page")).toHaveLength(1)
    const tbl = wAll(xml, "tbl")[0]
    expect(serializeXml(wKid(tbl, "tblPr")!)).toContain('w:val="double"')
    expect(wKids(tbl, "tr")).toHaveLength(3)
    expect(wAll(tbl, "tcW").every((n) => wAttr(n, "w") === "3000")).toBe(true)
    expect(wAll(tbl, "trHeight")).toHaveLength(2)
    const reread = await parseDocument(output)
    expect(reread.blocks.filter((b) => b.kind === "heading").map((b) => [b.text, b.level])).toEqual(headings.map((b) => [b.text, b.level]))
    expect(reread.blocks.filter((b) => b.text === "Replace this guidance.")).toHaveLength(2) // empty mapped slot and unmapped slot
    expect(await readStamp(result)).toMatchObject({ project_id: "project", kind: "draft" })
    const generated = reread.blocks.find((b) => b.text === "Generated introduction.")!
    expect(serializeXml(generated.element)).toContain('w:after="321"')
    expect(serializeXml(generated.element)).toContain('w:ascii="Cambria"')
  })

  it("places new descendants in their parent slot and copies image media with collision-safe relationships", async () => {
    const input = await template(), parsed = await parseDocument(input)
    const doc = document()
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
    doc.sections = [
      { id: "slot:features", number: "1", heading: "Requirements", level: 1, blocks: [] },
      { id: "feature:F1", number: "1.1", heading: "New feature", level: 2, blocks: [{ type: "image", png, caption: "New diagram" }, { type: "image", png }, { type: "bullet_list", items: [runs("First item"), runs("Second item")] }, { type: "page_break" }] }
    ]
    const output = await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "slot:features" }])
    const result = await DocxPackage.load(output), xml = await result.requireXml("word/document.xml")
    expect(wAll(xml, "t").map((t) => t.textContent).join("")).toContain("New feature")
    expect((await parseDocument(output)).blocks.filter((b) => b.kind === "heading").map((b) => b.text)).toEqual(parsed.blocks.filter((b) => b.kind === "heading").map((b) => b.text))
    expect(await result.binary("word/media/flintflow1.png")).toEqual(Buffer.from("original image"))
    expect(await result.binary("word/media/flintflow2.png")).toEqual(png)
    expect(await result.binary("word/media/flintflow3.png")).toEqual(png)
    const ids = Array.from(xml.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "docPr")).map((e) => e.getAttribute("id"))
    expect(new Set(ids).size).toBe(2)
    for (const blip of Array.from(xml.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "blip"))) expect(await result.resolveRelationship("word/document.xml", blip.getAttributeNS(NS.r, "embed")!)).toMatch(/^word\/media\/flintflow[23]\.png$/)
  })

  it("rejects unresolved mapped headings and generated content without a template parent", async () => {
    const input = await template()
    await expect(writeTemplateDocx(document(), input, [{ block_id: "B9999", section_id: "fixed:1" }])).rejects.toMatchObject({ code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
    const parsed = await parseDocument(input), doc = document()
    doc.sections = [{ id: "feature:F1", number: "", heading: "Orphan", level: 1, blocks: [{ type: "paragraph", runs: runs("Must not disappear.") }] }]
    await expect(writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }])).rejects.toMatchObject({ code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
  })

  it("mismatched table schemas never guess columns or append overflow - the FlintFlow table is written as is (FLF-372)", async () => {
    const input = await template(), parsed = await parseDocument(input), doc = document()
    doc.sections = [{ id: "fixed:1", number: "1", heading: "Requirements", level: 1, blocks: [{ type: "table", header: [runs("ID"), runs("Name"), runs("Role"), runs("Permissions")], rows: [[runs("A01"), runs("Manager"), runs("Manage club"), runs("Approve members")]] }] }]
    const output = await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }])
    const table = (await parseDocument(output)).blocks.find((b) => b.kind === "table")!
    expect(table.rows).toEqual([
      ["ID", "Name", "Role", "Permissions"],
      ["A01", "Manager", "Manage club", "Approve members"]
    ])
  })

  it("FLF-372: tiêu đề cột tiếng Việt tách nhiều run vẫn khớp; cột FlintFlow mẫu không có thì bỏ, không hỏng cả lượt", async () => {
    // Word tách "Thuật ngữ" thành nhiều run quanh dấu tiếng Việt
    const split = (...parts: string[]) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p>${parts.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join("")}</w:p></w:tc>`
    const glossary = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${split("Thu", "ật ng", "ữ")}${split("Đ", "ị", "nh nghĩa")}</w:tr><w:tr>${cell("[term]")}${cell("[definition]")}</w:tr></w:tbl>`
    const input = await template(glossary), parsed = await parseDocument(input), doc = document()
    doc.sections = [{ id: "fixed:5.5", number: "1", heading: "Requirements", level: 1, blocks: [{ type: "table", header: [runs("Thuật ngữ"), runs("Tiếng Việt"), runs("Định nghĩa")], rows: [[runs("SRS"), runs("Đặc tả yêu cầu"), runs("Software Requirements Specification")]] }] }]
    const output = await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:5.5" }])
    const xml = await (await DocxPackage.load(output)).requireXml("word/document.xml")
    const rows = wKids(wAll(xml, "tbl")[0], "tr").map((tr) => wKids(tr, "tc").map((tc) => wAll(tc, "t").map((t) => t.textContent).join("")))
    expect(rows).toEqual([
      ["Thuật ngữ", "Định nghĩa"],
      ["SRS", "Software Requirements Specification"]
    ])
  })

  it("FLF-372: bảng ghép cột lúc upload chưa có field (bản ghi cũ) ⇒ ghép theo tên cột của từ điển (ma trận kiểm chứng)", async () => {
    const head = (...names: string[]) => `<w:tr>${names.map((n) => cell(n)).join("")}</w:tr>`
    const verification = `<w:tbl><w:tblPr/><w:tblGrid>${"<w:gridCol w:w=\"2000\"/>".repeat(5)}</w:tblGrid>${head("Mã yêu cầu", "Phương pháp", "Ca kiểm thử / Tạo tác", "Trạng thái", "Bằng chứng")}${head("[FR-xx]", "[Test]", "[TC-xx]", "[Not run]", "[Link]")}</w:tbl>`
    const input = await template(verification), parsed = await parseDocument(input), doc = document()
    const tableBlock = parsed.blocks.find((b) => b.kind === "table")!
    doc.sections = [{ id: "slot:verification", number: "1", heading: "Requirements", level: 1, blocks: [{ type: "table", header: [runs("Yêu cầu"), runs("Phương pháp"), runs("Tài liệu kiểm"), runs("Trạng thái"), runs("Bằng chứng")], rows: [[runs("FR-01"), runs("Kiểm thử"), runs("TC-FR-01"), runs("not run"), runs("")]] }] }]
    const legacyMap = [0, 1, 2, 3, 4].map((column_index) => ({ block_id: tableBlock.block_id, column_index, header: "", field_path: null, confidence: 0.9, confirmed: true }))
    const output = await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "slot:verification" }], legacyMap)
    const xml = await (await DocxPackage.load(output)).requireXml("word/document.xml")
    const rows = wKids(wAll(xml, "tbl")[0], "tr").map((tr) => wKids(tr, "tc").map((tc) => wAll(tc, "t").map((t) => t.textContent).join("")))
    expect(rows).toEqual([
      ["Mã yêu cầu", "Phương pháp", "Ca kiểm thử / Tạo tác", "Trạng thái", "Bằng chứng"],
      ["FR-01", "Kiểm thử", "TC-FR-01", "not run", ""]
    ])
  })

  it("updates an existing revision history table with source columns and keeps leading layout breaks", async () => {
    const original = await JSZip.loadAsync(await template())
    const xml = (await original.file("word/document.xml")!.async("string")).replace(`${heading("Requirements")}${body}`, `${heading("Requirements")}<w:p><w:r><w:br w:type="page"/></w:r></w:p>${body}`)
    original.file("word/document.xml", xml.replace("<w:t>A</w:t>", "<w:t>Author</w:t>").replace("<w:t>B</w:t>", "<w:t>Description</w:t>"))
    const input = await original.generateAsync({ type: "nodebuffer" }), parsed = await parseDocument(input), doc = document()
    doc.recordOfChanges = [{ date: "2026-11-04", version: "v1", in_charge: "Editor", description: "Updated requirements", change_type: "M" }]
    const output = await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:I" }])
    const result = await parseDocument(output), h = result.blocks.find((b) => b.kind === "heading")!
    expect(wAll(h.element.nextSibling as Element, "br").some((b) => wAttr(b, "type") === "page")).toBe(true)
    const table = result.blocks.find((b) => b.kind === "table")!
    expect(table.rows?.[0]).toEqual(["Author", "Description"])
    expect(table.text).toContain("Editor")
    expect(table.text).toContain("Updated requirements")
    expect(table.text).not.toContain("Change type:")
  })

  it("FLF-372: bảng Lịch sử sửa đổi tiêu đề tiếng Việt (mẫu jam01) điền đúng cột", async () => {
    const head = (...names: string[]) => `<w:tr>${names.map((n) => cell(n)).join("")}</w:tr>`
    const history = `<w:tbl><w:tblPr/><w:tblGrid>${"<w:gridCol w:w=\"2000\"/>".repeat(4)}</w:tblGrid>${head("Người thực hiện", "Ngày", "Lý do thay đổi", "Phiên bản")}${head("[Tên]", "[dd/mm/yyyy]", "[Lý do]", "[x.y]")}</w:tbl>`
    const input = await template(history), parsed = await parseDocument(input), doc = document()
    doc.recordOfChanges = [{ date: "05/11/2026", version: "0.1", in_charge: "Tuấn Anh", description: "Bản đầu", change_type: "A" }]
    const output = await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:I" }])
    const table = (await parseDocument(output)).blocks.find((b) => b.kind === "table")!
    expect(table.rows).toEqual([
      ["Người thực hiện", "Ngày", "Lý do thay đổi", "Phiên bản"],
      ["Tuấn Anh", "05/11/2026", "Bản đầu", "0.1"]
    ])
  })

  it("FLF-378: mẫu của dự án mới (stripTemplateText) - mục chưa soạn bỏ hướng dẫn / ví dụ, bảng mẫu giữ tiêu đề bỏ dòng mẫu", async () => {
    const input = await template(), parsed = await parseDocument(input)
    const requirements = parsed.blocks.find((b) => b.kind === "heading")!
    const doc = document()
    const plain = await parseDocument(await writeTemplateDocx(doc, input, [{ block_id: requirements.block_id, section_id: "fixed:1" }]))
    // Mặc định (dự án có sẵn): mục trống giữ nguyên chữ của file
    expect(plain.blocks.some((b) => b.text === "Replace this guidance.")).toBe(true)
    const stripped = await parseDocument(await writeTemplateDocx(doc, input, [{ block_id: requirements.block_id, section_id: "fixed:1" }], [], { stripTemplateText: true }))
    const start = stripped.blocks.findIndex((b) => b.text === "Requirements")
    const end = stripped.blocks.findIndex((b) => b.text === "Repeated")
    const between = stripped.blocks.slice(start + 1, end)
    expect(between.some((b) => b.text === "Replace this guidance.")).toBe(false)
    expect(between.find((b) => b.kind === "table")!.rows).toEqual([["A", "B"]])
  })

  it("P09 (#25): mục của mẫu chưa có dữ liệu (bảng thực thể rỗng) ⇒ bỏ hình mẫu (ảnh / OLE), giữ field và ngắt trang", async () => {
    const picture = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="Sample ERD"/></wp:inline></w:drawing></w:r></w:p>`
    const ole = `<w:p><w:r><w:object><v:shape xmlns:v="urn:schemas-microsoft-com:vml" id="ole1"/></w:object></w:r></w:p>`
    const field = `<w:p><w:fldSimple w:instr=" TOC "><w:r><w:t>toc</w:t></w:r></w:fldSimple></w:p>`
    const zip = await JSZip.loadAsync(await template())
    zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace(`${heading("Requirements")}${body}`, `${heading("Requirements")}${body}${picture}${ole}${field}`))
    const input = await zip.generateAsync({ type: "nodebuffer" }), parsed = await parseDocument(input)
    const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
    const region = async (opts: { stripTemplateText?: boolean }) => {
      const xml = (await DocxPackage.load(await writeTemplateDocx(document(), input, map, [], opts))).requireXml("word/document.xml")
      const text = serializeXml(await xml)
      return text.slice(text.indexOf(">Requirements<"), text.indexOf(">Repeated<"))
    }
    const stripped = await region({ stripTemplateText: true })
    expect(stripped).not.toContain("<w:drawing")
    expect(stripped).not.toContain("<w:object")
    expect(stripped).toContain('w:instr=" TOC "')
    expect(stripped).toContain('w:type="page"')
    // Dự án có sẵn (không phải khung mẫu): ảnh của file là nội dung — giữ
    expect(await region({})).toContain("<w:drawing")
  })

  it("FLF-378: mục đã soạn - bảng mẫu không được điền vẫn bỏ dòng mẫu khi stripTemplateText", async () => {
    const input = await template(), parsed = await parseDocument(input), doc = document()
    doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [{ type: "paragraph", runs: runs("Drafted requirement") }] }]
    const output = await parseDocument(await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }], [], { stripTemplateText: true }))
    expect(output.blocks.some((b) => b.text === "Drafted requirement")).toBe(true)
    expect(output.blocks.find((b) => b.kind === "table")!.rows).toEqual([["A", "B"]])
  })

  describe("dự án 'Upload SRS có sẵn' (keepSource / legacyRecordCount)", () => {
    const fieldParagraph = `<w:p><w:bookmarkStart w:id="900" w:name="_Ref555"/><w:r><w:t xml:space="preserve">Figure </w:t></w:r><w:fldSimple w:instr=" SEQ Figure \\* ARABIC "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:bookmarkEnd w:id="900"/></w:p>`
    const withField = async () => {
      const zip = await JSZip.loadAsync(await template())
      zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace(`${heading("Requirements")}${body}`, `${heading("Requirements")}${body}${fieldParagraph}`))
      return zip.generateAsync({ type: "nodebuffer" })
    }
    const bodyXml = async (buf: Buffer) => (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string")

    it("mục nguyên vẹn ⇒ không đụng node nào của file gốc (kể cả field / bookmark), không 422", async () => {
      const input = await withField(), parsed = await parseDocument(input), doc = document()
      doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [{ type: "paragraph", runs: runs("Rendered from Spine") }] }]
      const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
      // Mẫu để điền (không keepSource) vẫn chặn field như trước
      await expect(writeTemplateDocx(doc, input, map)).rejects.toMatchObject({ code: "TEMPLATE_LAYOUT_UNAVAILABLE" })
      const output = await writeTemplateDocx(doc, input, map, [], { keepSource: new Set(["fixed:1"]) })
      expect(await bodyXml(output)).toBe(await bodyXml(input))
    })

    it("mục bị sửa có field ⇒ dựng lại chữ, giữ đoạn field / bookmark tại chỗ thay vì hỏng cả file", async () => {
      const input = await withField(), parsed = await parseDocument(input), doc = document()
      doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [{ type: "paragraph", runs: runs("Changed by CR") }] }]
      const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
      const xml = await bodyXml(await writeTemplateDocx(doc, input, map, [], { keepSource: new Set() }))
      expect(xml).toContain("Changed by CR")
      expect(xml).not.toContain("Replace this guidance.</w:t></w:r></w:p><w:tbl>")
      expect(xml).toContain('w:instr=" SEQ Figure')
      expect(xml).toContain('w:name="_Ref555"')
    })

    it("mục FlintFlow tự thêm mà file không có, chưa đổi ⇒ không in, không lỗi 'No template parent'", async () => {
      const input = await template(), parsed = await parseDocument(input), doc = document()
      doc.sections = [{ id: "fixed:9.9", heading: "Generated by FlintFlow", number: "9.9", level: 1, blocks: [{ type: "paragraph", runs: runs("Not in the file") }] }]
      const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
      const xml = await bodyXml(await writeTemplateDocx(doc, input, map, [], { keepSource: new Set(["fixed:9.9"]) }))
      expect(xml).not.toContain("Not in the file")
    })

    it("bảng lịch sử gốc giữ nguyên, chỉ thêm dòng mới vào cuối theo cột của bảng; cột lạ để trống", async () => {
      const original = await JSZip.loadAsync(await template())
      const xml = (await original.file("word/document.xml")!.async("string"))
        .replace("<w:t>A</w:t>", "<w:t>Author</w:t>").replace("<w:t>B</w:t>", "<w:t>Approved by</w:t>")
        .replace("<w:t>sample</w:t>", "<w:t>Hoai Linh</w:t>").replace("<w:t>sample</w:t>", "<w:t>Head of IT</w:t>")
      original.file("word/document.xml", xml)
      const input = await original.generateAsync({ type: "nodebuffer" }), parsed = await parseDocument(input), doc = document()
      doc.recordOfChanges = [
        { date: "2026-09-01", version: "1.0", in_charge: "Hoai Linh", description: "Initial version", change_type: "A" },
        { date: "2026-11-06", version: "1.1", in_charge: "Editor", description: "CR-001 Update rules", change_type: "M" }
      ]
      const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:I" }]
      const result = await parseDocument(await writeTemplateDocx(doc, input, map, [], { keepSource: new Set(), legacyRecordCount: 1 }))
      const table = result.blocks.find((b) => b.kind === "table")!
      expect(table.rows).toEqual([["Author", "Approved by"], ["Hoai Linh", "Head of IT"], ["Editor", ""]])
    })

    it("FLF-411 #26: bảng lịch sử có dòng trống kẻ sẵn ⇒ điền dòng trống đầu tiên, hết dòng trống mới thêm vào cuối", async () => {
      const blank = `<w:tr>${cell("")}${cell("")}</w:tr>`
      const history = sourceTable.replace("<w:t>A</w:t>", "<w:t>Author</w:t>").replace("<w:t>B</w:t>", "<w:t>Description</w:t>")
        .replace("<w:t>sample</w:t>", "<w:t>Hoai Linh</w:t>").replace("<w:t>sample</w:t>", "<w:t>Initial version</w:t>")
        .replace("</w:tbl>", `${blank}${blank}</w:tbl>`)
      const input = await template(history), parsed = await parseDocument(input)
      const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:I" }]
      const record = (n: number) => ({ date: "2026-11-12", version: `1.${n}`, in_charge: `Editor ${n}`, description: `CR-00${n}`, change_type: "M" as const })
      const rowsOf = async (records: ReturnType<typeof record>[]) => {
        const doc = document()
        doc.recordOfChanges = [{ date: "2026-09-01", version: "1.0", in_charge: "Hoai Linh", description: "Initial version", change_type: "A" }, ...records]
        const result = await parseDocument(await writeTemplateDocx(doc, input, map, [], { keepSource: new Set(), legacyRecordCount: 1 }))
        return result.blocks.find((b) => b.kind === "table")!.rows
      }
      expect(await rowsOf([record(1)])).toEqual([["Author", "Description"], ["Hoai Linh", "Initial version"], ["Editor 1", "CR-001"], ["", ""]])
      expect(await rowsOf([record(1), record(2), record(3)])).toEqual([
        ["Author", "Description"], ["Hoai Linh", "Initial version"], ["Editor 1", "CR-001"], ["Editor 2", "CR-002"], ["Editor 3", "CR-003"]
      ])
    })

    describe("FLF-411 #25: mục bị xoá hết dữ liệu (không nguyên trạng, bản in rỗng)", () => {
      const guidance = body.replace("Replace this guidance.", "[Describe the requirements of the system.]")
      const withGuidance = async () => {
        const zip = await JSZip.loadAsync(await template())
        zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace(`${heading("Requirements")}${body}`, `${heading("Requirements")}${guidance}${body}`))
        return zip.generateAsync({ type: "nodebuffer" })
      }
      const between = async (output: Buffer) => {
        const blocks = (await parseDocument(output)).blocks
        return blocks.slice(blocks.findIndex((b) => b.text === "Requirements") + 1, blocks.findIndex((b) => b.text === "Repeated"))
      }
      const emptied = (blocks: RenderedDocument["sections"][number]["blocks"] = []) => {
        const doc = document()
        doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks }]
        return doc
      }

      it("bỏ đoạn dữ liệu gốc, bảng chỉ còn hàng tiêu đề, giữ heading + đoạn hướng dẫn của mẫu", async () => {
        const input = await withGuidance(), parsed = await parseDocument(input)
        const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
        const blocks = await between(await writeTemplateDocx(emptied(), input, map, [], { keepSource: new Set() }))
        expect(blocks.map((b) => b.text)).toContain("[Describe the requirements of the system.]")
        expect(blocks.some((b) => b.text === "Replace this guidance.")).toBe(false)
        expect(blocks.find((b) => b.kind === "table")!.rows).toEqual([["A", "B"]])
      })

      it("mục nguyên trạng vốn trống ⇒ vẫn in nguyên văn file gốc", async () => {
        const input = await withGuidance(), parsed = await parseDocument(input)
        const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
        const xml = await bodyXml(await writeTemplateDocx(emptied(), input, map, [], { keepSource: new Set(["fixed:1"]) }))
        expect(xml).toBe(await bodyXml(input))
      })

      it("file gốc không có hướng dẫn ⇒ in hướng dẫn của mẫu mà bản in mang theo", async () => {
        const input = await template(), parsed = await parseDocument(input)
        const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
        const doc = emptied([{ type: "paragraph", runs: runs("[List the requirements.]") }])
        const blocks = await between(await writeTemplateDocx(doc, input, map, [], { keepSource: new Set() }))
        expect(blocks[0].text).toBe("[List the requirements.]")
        expect(blocks.some((b) => b.text === "Replace this guidance.")).toBe(false)
      })
    })
  })

  describe("FLF-468 lát A: mục của phần tử đã xoá (importedSectionIds)", () => {
    const toc = `<w:p><w:bookmarkStart w:id="700" w:name="_Toc700"/><w:fldSimple w:instr=" TOC \\o &quot;1-3&quot; \\h "><w:r><w:t>Requirements\t1</w:t></w:r></w:fldSimple><w:bookmarkEnd w:id="700"/></w:p>`
    const withToc = async () => {
      const zip = await JSZip.loadAsync(await template())
      zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace(heading("Requirements"), `${toc}${heading("Requirements").replace("<w:p>", `<w:p><w:bookmarkStart w:id="701" w:name="_Toc701"/>`).replace("</w:p>", "<w:bookmarkEnd w:id=\"701\"/></w:p>")}`))
      return zip.generateAsync({ type: "nodebuffer" })
    }

    it("mục chức năng (function:) đã xoá ⇒ bỏ cả heading lẫn thân, gỡ bookmark TOC của heading, giữ mục khác", async () => {
      const input = await withToc(), parsed = await parseDocument(input), doc = document()
      const headingBlock = parsed.blocks.find((b) => b.kind === "heading" && b.text === "Requirements")!
      const map = [{ block_id: headingBlock.block_id, section_id: "function:FN1" }]
      // Spine hiện tại không còn section function:FN1 ⇒ doc.sections rỗng; importedSectionIds báo nó có lúc import
      const output = await writeTemplateDocx(doc, input, map, [], { keepSource: new Set(), importedSectionIds: new Set(["function:FN1"]) })
      const result = await parseDocument(output)
      const xml = await (await JSZip.loadAsync(output)).file("word/document.xml")!.async("string")
      // Heading "Requirements" và chính thân của nó (table + đoạn ngay sau nó) biến mất — chỉ còn 3 đoạn "Replace this
      // guidance." của các mục khác (Repeated × 2, Unmapped) không bị đụng tới
      expect(result.blocks.some((b) => b.text === "Requirements")).toBe(false)
      expect(result.blocks.filter((b) => b.text === "Replace this guidance.")).toHaveLength(3)
      expect(result.blocks.some((b) => b.kind === "table")).toBe(false)
      expect(xml).not.toContain("_Toc701")
      // Mục anh em khác (Unmapped) vẫn còn
      expect(result.blocks.some((b) => b.text === "Unmapped")).toBe(true)
    })

    it("mục cố định của mẫu đã mất dữ liệu từ lúc import ⇒ giữ heading, thân về trống (bảng chỉ còn hàng tiêu đề)", async () => {
      const input = await template(), parsed = await parseDocument(input), doc = document()
      const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
      const output = await writeTemplateDocx(doc, input, map, [], { keepSource: new Set(), importedSectionIds: new Set(["fixed:1"]) })
      const result = await parseDocument(output)
      expect(result.blocks.some((b) => b.text === "Requirements")).toBe(true)
      // Chỉ đoạn thân của "Requirements" bị bỏ; 3 đoạn "Replace this guidance." của mục khác vẫn còn
      expect(result.blocks.filter((b) => b.text === "Replace this guidance.")).toHaveLength(3)
      expect(result.blocks.find((b) => b.kind === "table")!.rows).toEqual([["A", "B"]])
    })

    it("mục chưa từng có lúc import (không trong importedSectionIds) ⇒ giữ nguyên như trước (đường cũ)", async () => {
      const input = await template(), parsed = await parseDocument(input), doc = document()
      const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "function:FN1" }]
      const output = await writeTemplateDocx(doc, input, map, [], { keepSource: new Set(), importedSectionIds: new Set() })
      const result = await parseDocument(output)
      expect(result.blocks.some((b) => b.text === "Requirements")).toBe(true)
      expect(result.blocks.some((b) => b.text === "Replace this guidance.")).toBe(true)
    })
  })

  describe("xoá mục ở file đánh số gõ tay: số heading anh em phía sau dồn theo bản in", () => {
    const screenTable = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${cell("Screen")}${cell("Function")}</w:tr><w:tr>${cell("Home")}${cell("3.3 Discovery")}</w:tr><w:tr>${cell("Cart page")}${cell("3.4 Cart")}</w:tr></w:tbl>`
    const numberedFile = async () => {
      const zip = new JSZip()
      zip.file("[Content_Types].xml", `<Types xmlns="${NS.ct}"><Default Extension="xml" ContentType="application/xml"/></Types>`)
      zip.file("word/document.xml", `<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:body>${heading("3 Functional Requirements")}${heading("3.1 Overview", 2)}${screenTable}${heading("3.2 Account", 2)}${body}${heading("3.3 Discovery", 2)}${body}${heading("3.4 Cart", 2)}${body}<w:sectPr/></w:body></w:document>`)
      zip.file("word/styles.xml", styles)
      zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="${NS.rels}"></Relationships>`)
      return zip.generateAsync({ type: "nodebuffer" })
    }

    it("xoá 3.2 ⇒ heading 3.3 / 3.4 giữ từ file nền ghi thành 3.2 / 3.3, ô bảng ghi đúng chữ heading cũ đổi theo", async () => {
      const input = await numberedFile(), parsed = await parseDocument(input), doc = document()
      const id = (text: string) => parsed.blocks.find((b) => b.kind === "heading" && b.text === text)!.block_id
      const map = [
        { block_id: id("3 Functional Requirements"), section_id: "fixed:3" },
        { block_id: id("3.1 Overview"), section_id: "fixed:3.1" },
        { block_id: id("3.2 Account"), section_id: "feature:F2" },
        { block_id: id("3.3 Discovery"), section_id: "feature:F3" },
        { block_id: id("3.4 Cart"), section_id: "feature:F4" }
      ]
      doc.sections = [
        { id: "fixed:3", heading: "Functional Requirements", number: "3", level: 1, blocks: [] },
        { id: "fixed:3.1", heading: "Overview", number: "3.1", level: 2, blocks: [] },
        { id: "feature:F3", heading: "Discovery", number: "3.2", level: 2, blocks: [] },
        { id: "feature:F4", heading: "Cart", number: "3.3", level: 2, blocks: [] }
      ]
      const keepSource = new Set(doc.sections.map((s) => s.id))
      const output = await writeTemplateDocx(doc, input, map, [], { keepSource, importedSectionIds: new Set([...keepSource, "feature:F2"]) })
      const result = await parseDocument(output)
      expect(result.blocks.filter((b) => b.kind === "heading").map((b) => b.text)).toEqual(["3 Functional Requirements", "3.1 Overview", "3.2 Discovery", "3.3 Cart"])
      expect(result.blocks.find((b) => b.kind === "table")!.rows).toEqual([["Screen", "Function"], ["Home", "3.2 Discovery"], ["Cart page", "3.3 Cart"]])
      // Heading giữ định dạng run gốc (chỉ đổi số trong chữ)
      const kept = result.blocks.find((b) => b.kind === "heading" && b.text === "3.2 Discovery")!.element
      expect(wAll(kept, "b")).toHaveLength(1)
    })

    it("số của bản in trùng số gõ tay của file ⇒ không đổi gì", async () => {
      const input = await numberedFile(), parsed = await parseDocument(input), doc = document()
      const id = (text: string) => parsed.blocks.find((b) => b.kind === "heading" && b.text === text)!.block_id
      const map = [{ block_id: id("3.3 Discovery"), section_id: "feature:F3" }]
      doc.sections = [{ id: "feature:F3", heading: "Discovery", number: "3.3", level: 2, blocks: [] }]
      const output = await writeTemplateDocx(doc, input, map, [], { keepSource: new Set(["feature:F3"]) })
      const result = await parseDocument(output)
      expect(result.blocks.filter((b) => b.kind === "heading").map((b) => b.text)).toContain("3.3 Discovery")
      expect(result.blocks.find((b) => b.kind === "table")!.rows![1]).toEqual(["Home", "3.3 Discovery"])
    })
  })

  describe("FLF-468 lát D: mục mẫu cố định không có bảng nguồn (\"Cần chốt\" #1)", () => {
    it("bảng 2 cột (mã + nội dung) ⇒ danh sách \"mã – nội dung\", không phải đoạn 'Nhãn: giá trị'", async () => {
      const input = await template(), parsed = await parseDocument(input), doc = document()
      const repeated = parsed.blocks.filter((b) => b.kind === "heading" && b.text === "Repeated")[0]
      const map = [{ block_id: repeated.block_id, section_id: "slot:business_rules" }]
      doc.sections = [{
        id: "slot:business_rules", heading: "Repeated", number: "5.1", level: 2,
        blocks: [{ type: "table", header: [runs("ID"), runs("Rule")], rows: [[runs("BR-01"), runs("Only University accounts.")]] }]
      }]
      const output = await parseDocument(await writeTemplateDocx(doc, input, map))
      expect(output.blocks.some((b) => (b.text ?? "").includes("BR-01 – Only University accounts."))).toBe(true)
      // Bảng nguồn của mục khác ("Requirements") vẫn còn — chỉ mục đã vá (Repeated) không sinh bảng mới
      expect(output.blocks.filter((b) => b.kind === "table")).toHaveLength(1)
      expect(output.blocks.some((b) => (b.text ?? "").includes("ID:") || (b.text ?? "").includes("Rule:"))).toBe(false)
    })

    it("bảng từ 3 cột (thông báo) ⇒ in bảng thật tại chỗ, không trải thành đoạn", async () => {
      const input = await template(), parsed = await parseDocument(input), doc = document()
      const repeated = parsed.blocks.filter((b) => b.kind === "heading" && b.text === "Repeated")[0]
      const map = [{ block_id: repeated.block_id, section_id: "slot:messages" }]
      doc.sections = [{
        id: "slot:messages", heading: "Repeated", number: "5.3", level: 2,
        blocks: [{ type: "table", header: [runs("Code"), runs("Type"), runs("Context"), runs("Content")], rows: [[runs("PAY-010"), runs(""), runs(""), runs("Not enough balance.")]] }]
      }]
      const output = await parseDocument(await writeTemplateDocx(doc, input, map))
      const table = output.blocks.find((b) => b.kind === "table" && b.rows?.some((r) => r[0] === "PAY-010"))
      expect(table).toBeDefined()
      expect(table!.rows).toEqual([["Code", "Type", "Context", "Content"], ["PAY-010", "", "", "Not enough balance."]])
      expect(output.blocks.some((b) => (b.text ?? "").includes("Code:"))).toBe(false)
    })
  })

  describe("FLF-416 chế độ 4: sắp lại bố cục file khách (rearrange)", () => {
    it("mục FPT soạn thêm ⇒ heading mới theo style heading cùng cấp, đúng vị trí bản in; mục Ngoài phạm vi (kèm mục con) xuống cuối", async () => {
      const input = await template(), parsed = await parseDocument(input), doc = document()
      const heads = parsed.blocks.filter((b) => b.kind === "heading")
      // File: Requirements (H1, Ngoài phạm vi) › Repeated, Repeated (H2) · Unmapped (H1, mục FPT có sẵn)
      const map = [
        { block_id: heads[0].block_id, section_id: "custom:cost" },
        { block_id: heads[1].block_id, section_id: "custom:cost-a" },
        { block_id: heads[2].block_id, section_id: "custom:cost-b" },
        { block_id: heads[3].block_id, section_id: "fixed:2" }
      ]
      doc.sections = [
        { id: "fixed:2", heading: "Unmapped", number: "1", level: 1, blocks: [] },
        { id: "fixed:V.5", heading: "Glossary", number: "2", level: 1, blocks: [{ type: "paragraph", runs: runs("Drafted glossary") }, { type: "table", header: [runs("Term"), runs("Meaning")], rows: [[runs("SRS"), runs("Software Requirements Specification")]] }] },
        { id: "custom:cost", heading: "Requirements", number: "3", level: 1, blocks: [] },
        { id: "custom:cost-a", heading: "Repeated", number: "3.1", level: 2, blocks: [] },
        { id: "custom:cost-b", heading: "Repeated", number: "3.2", level: 2, blocks: [] }
      ]
      const keep = new Set(["fixed:2", "custom:cost", "custom:cost-a", "custom:cost-b"])
      const out = await writeTemplateDocx(doc, input, map, [], { keepSource: keep, rearrange: { moveToEnd: ["custom:cost"] } })
      const blocks = (await parseDocument(out)).blocks
      expect(blocks.filter((b) => b.kind === "heading").map((b) => b.text)).toEqual(["Unmapped", "Glossary", "Requirements", "Repeated", "Repeated"])
      const glossary = blocks.find((b) => b.kind === "heading" && b.text === "Glossary")!
      expect(wAttr(wKid(wKid(glossary.element, "pPr")!, "pStyle"), "val")).toBe("Heading1")
      // Nội dung mục chèn ngay dưới heading mới, bảng là bảng thật
      const at = (pred: (b: (typeof blocks)[number]) => boolean) => blocks.findIndex(pred)
      expect(at((b) => b.text === "Drafted glossary")).toBeGreaterThan(at((b) => b.text === "Glossary"))
      expect(at((b) => b.kind === "table" && b.rows?.[0]?.[0] === "Term")).toBeLessThan(at((b) => b.text === "Requirements"))
      // Bảng của mục Ngoài phạm vi đi cùng mục; sectPr của thân vẫn cuối cùng
      expect(at((b) => b.kind === "table" && b.rows?.[0]?.[0] === "A")).toBeGreaterThan(at((b) => b.text === "Requirements"))
      const xml = await (await JSZip.loadAsync(out)).file("word/document.xml")!.async("string")
      expect(xml.trimEnd()).toMatch(/<\/w:sectPr><\/w:body><\/w:document>$/)
    })

    it("không rearrange ⇒ như cũ: mục không có heading gộp vào mục cha thành đoạn đậm", async () => {
      const input = await template(), parsed = await parseDocument(input), doc = document()
      const map = [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }]
      doc.sections = [
        { id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [{ type: "paragraph", runs: runs("Own") }] },
        { id: "fixed:1.9", heading: "Child", number: "1.1", level: 2, blocks: [{ type: "paragraph", runs: runs("Child text") }] }
      ]
      const blocks = (await parseDocument(await writeTemplateDocx(doc, input, map, [], { keepSource: new Set() }))).blocks
      expect(blocks.some((b) => b.kind === "heading" && b.text === "Child")).toBe(false)
      expect(blocks.some((b) => b.text === "Child text")).toBe(true)
    })
  })
})

describe("FLF-468 (E2E-1): mục lặp mới ở chế độ giữ file gốc thành heading chèn mới", () => {
  /** File: "3. Functional" (H1) › "3.5 Billing" (H2) › "3.5.1 Pay" (H3), rồi "4. Non-Functional" (H1). Heading gõ số tay. */
  async function srsFile() {
    const zip = await JSZip.loadAsync(await template())
    zip.file("word/styles.xml", styles.replace("</w:styles>", '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/></w:style></w:styles>'))
    const text = (t: string, level: number) => heading(t, level)
    zip.file("word/document.xml", `<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:body><w:p><w:fldSimple w:instr="TOC \o &quot;1-3&quot;"><w:r><w:t>Contents</w:t></w:r></w:fldSimple></w:p>${text("3. Functional", 1)}${body.replace("Replace this guidance.", "Intro 3")}${text("3.5 Billing", 2)}${body.replace("Replace this guidance.", "Body 3.5")}${text("3.5.1 Pay", 3)}${body.replace("Replace this guidance.", "Body 3.5.1")}${text("4. Non-Functional", 1)}${body.replace("Replace this guidance.", "Body 4")}${text("5.5 Glossary", 2)}<w:sectPr><w:pgMar w:top="1134" w:left="1134"/></w:sectPr></w:body></w:document>`)
    const input = await zip.generateAsync({ type: "nodebuffer" }), parsed = await parseDocument(input)
    const heads = parsed.blocks.filter((b) => b.kind === "heading")
    const map = ["group:3", "feature:F-3.5", "function:FR-3.5.1", "group:4", "fixed:V.5"].map((section_id, i) => ({ block_id: heads[i].block_id, section_id }))
    return { input, map }
  }
  const sec = (id: string, headingText: string, number: string, level: number, text = ""): RenderedDocument["sections"][number] =>
    ({ id, heading: headingText, number, level, blocks: text ? [{ type: "paragraph", runs: runs(text) }] : [] })
  const keep = new Set(["group:3", "feature:F-3.5", "function:FR-3.5.1", "group:4", "fixed:V.5"])
  const headingTexts = (blocks: Awaited<ReturnType<typeof parseDocument>>["blocks"]) => blocks.filter((b) => b.kind === "heading").map((b) => b.text)

  it("tính năng + chức năng mới không có slot ⇒ 3.6 / 3.6.1 là heading trước heading '4.', vùng của '3.' không đổi", async () => {
    const { input, map } = await srsFile(), doc = document()
    doc.sections = [
      sec("group:3", "Functional", "3", 1, "Intro 3"), sec("feature:F-3.5", "Billing", "3.5", 2, "Body 3.5"), sec("function:FR-3.5.1", "Pay", "3.5.1", 3, "Body 3.5.1"),
      sec("feature:F-01", "Authentication", "3.6", 2), sec("function:FR-05", "Reset Password", "3.6.1", 3, "Reset body"),
      sec("group:4", "Non-Functional", "4", 1, "Body 4"), sec("fixed:V.5", "Glossary", "5.5", 2)
    ]
    const out = await writeTemplateDocx(doc, input, map, [], { keepSource: keep })
    const blocks = (await parseDocument(out)).blocks
    expect(headingTexts(blocks)).toEqual(["3. Functional", "3.5 Billing", "3.5.1 Pay", "3.6 Authentication", "3.6.1 Reset Password", "4. Non-Functional", "5.5 Glossary"])
    const feature = blocks.find((b) => b.text === "3.6 Authentication")!, fn = blocks.find((b) => b.text === "3.6.1 Reset Password")!
    expect(wAttr(wKid(wKid(feature.element, "pPr")!, "pStyle"), "val")).toBe("Heading2")
    expect(wAttr(wKid(wKid(fn.element, "pPr")!, "pStyle"), "val")).toBe("Heading3")
    // Thân chức năng mới đứng ngay sau heading của nó; không có chữ mới giữa "3." và "3.5"
    const at = (t: string) => blocks.findIndex((b) => b.text === t)
    expect(at("Reset body")).toBe(at("3.6.1 Reset Password") + 1)
    expect(blocks.slice(at("3. Functional"), at("3.5 Billing")).map((b) => b.text)).toEqual(["3. Functional", "Intro 3"])
    expect(blocks.find((b) => b.text === "Body 3.5")).toBeTruthy()
    // Mục lục tính lại khi mở file
    expect(await (await JSZip.loadAsync(out)).file("word/document.xml")!.async("string")).toContain('w:dirty="true"')
  })

  it("file chưa có heading cấp 4: heading mới theo style 'heading 4' của mẫu, có style thì dùng, không thì heading sâu nhất + outlineLvl", async () => {
    const { input, map } = await srsFile()
    const doc = document()
    doc.sections = [
      sec("group:3", "Functional", "3", 1, "Intro 3"), sec("feature:F-3.5", "Billing", "3.5", 2, "Body 3.5"), sec("function:FR-3.5.1", "Pay", "3.5.1", 3, "Body 3.5.1"),
      sec("function:FR-07", "Pay detail", "3.5.1.1", 4, "Detail body"), sec("group:4", "Non-Functional", "4", 1, "Body 4"), sec("fixed:V.5", "Glossary", "5.5", 2)
    ]
    const keepAll = { keepSource: new Set(["group:3", "feature:F-3.5", "function:FR-3.5.1", "group:4", "fixed:V.5"]) }
    // Mẫu không có style cấp 4 ⇒ heading cấp 3 + outlineLvl 3 (vẫn vào mục lục), không phải đoạn thường in đậm
    const plain = (await parseDocument(await writeTemplateDocx(doc, input, map, [], keepAll))).blocks.find((b) => b.text === "3.5.1.1 Pay detail")!
    expect(plain.kind).toBe("heading")
    expect(wAttr(wKid(wKid(plain.element, "pPr")!, "outlineLvl"), "val")).toBe("3")
    // Mẫu có style "heading 4" (chưa dùng trong thân) ⇒ dùng đúng style đó
    const zip = await JSZip.loadAsync(input)
    const st = (await zip.file("word/styles.xml")!.async("string")).replace("</w:styles>", '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/></w:style></w:styles>')
    zip.file("word/styles.xml", st)
    const withStyle = await zip.generateAsync({ type: "nodebuffer" })
    const styled = (await parseDocument(await writeTemplateDocx(doc, withStyle, map, [], keepAll))).blocks.find((b) => b.text === "3.5.1.1 Pay detail")!
    expect(wAttr(wKid(wKid(styled.element, "pPr")!, "pStyle"), "val")).toBe("Heading4")
  })

  it("chức năng mới của tính năng đã có ⇒ heading 3.5.2 sau 3.5.1, thân 3.5 không đổi", async () => {
    const { input, map } = await srsFile(), doc = document()
    doc.sections = [
      sec("group:3", "Functional", "3", 1, "Intro 3"), sec("feature:F-3.5", "Billing", "3.5", 2, "Body 3.5"), sec("function:FR-3.5.1", "Pay", "3.5.1", 3, "Body 3.5.1"),
      sec("function:FR-06", "Refund", "3.5.2", 3, "Refund body"), sec("group:4", "Non-Functional", "4", 1, "Body 4")
    ]
    const blocks = (await parseDocument(await writeTemplateDocx(doc, input, map, [], { keepSource: new Set(["group:3", "feature:F-3.5", "function:FR-3.5.1", "group:4"]) }))).blocks
    expect(headingTexts(blocks)).toEqual(["3. Functional", "3.5 Billing", "3.5.1 Pay", "3.5.2 Refund", "4. Non-Functional", "5.5 Glossary"])
    const at = (t: string) => blocks.findIndex((b) => b.text === t)
    expect(at("Body 3.5")).toBeLessThan(at("3.5.1 Pay"))
    expect(at("Body 3.5.1")).toBeLessThan(at("3.5.2 Refund"))
    expect(at("Refund body")).toBe(at("3.5.2 Refund") + 1)
  })

  it("không có mục mới ⇒ file không đổi và không yêu cầu cập nhật mục lục", async () => {
    const { input, map } = await srsFile(), doc = document()
    doc.sections = [sec("group:3", "Functional", "3", 1, "Intro 3"), sec("feature:F-3.5", "Billing", "3.5", 2, "Body 3.5"), sec("function:FR-3.5.1", "Pay", "3.5.1", 3, "Body 3.5.1"), sec("group:4", "Non-Functional", "4", 1, "Body 4")]
    const out = await writeTemplateDocx(doc, input, map, [], { keepSource: keep })
    expect(headingTexts((await parseDocument(out)).blocks)).toEqual(["3. Functional", "3.5 Billing", "3.5.1 Pay", "4. Non-Functional", "5.5 Glossary"])
    expect(await (await JSZip.loadAsync(out)).file("word/document.xml")!.async("string")).not.toContain('w:dirty="true"')
  })
})

describe("FLF-413 - isFrameHeading", () => {
  it("heading mục lặp có chữ là chỗ điền (bỏ số gõ tay) ⇒ khung", () => {
    expect(isFrameHeading("feature:F-3.2", "3.2 <<Feature Name 1>>")).toBe(true)
    expect(isFrameHeading("function:FR-3.2.1", "3.2.1 <<Function Name 1>>")).toBe(true)
    expect(isFrameHeading("feature:F-3.2", "3.2 Booking")).toBe(false)
    expect(isFrameHeading("fixed:3.1", "<<Overview>>")).toBe(false)
  })
})
