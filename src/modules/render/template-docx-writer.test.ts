import JSZip from "jszip"
import { XMLSerializer } from "@xmldom/xmldom"
import { describe, expect, it } from "vitest"
import { DocxPackage, readStamp } from "../docx-ooxml/index.js"
import { NS, wAll, wAttr, wKid, wKids } from "../docx-ooxml/xml.js"
import { parseDocument } from "../import/parse.service.js"
import type { RenderedDocument } from "./rendered-document.types.js"
import { writeTemplateDocx } from "./template-docx-writer.js"

const styles = `<w:styles xmlns:w="${NS.w}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`
const heading = (text: string, level = 1) => `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/><w:keepNext/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${text}</w:t></w:r></w:p>`
const body = `<w:p><w:pPr><w:spacing w:after="321"/><w:ind w:left="432"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Cambria"/><w:sz w:val="23"/></w:rPr><w:t>Replace this guidance.</w:t></w:r></w:p>`
const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:fill="AABBCC"/></w:tcPr>${body.replace("Replace this guidance.", text)}</w:tc>`
const sourceTable = `<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblBorders><w:top w:val="double"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("A")}${cell("B")}</w:tr><w:tr><w:trPr><w:trHeight w:val="444"/></w:trPr>${cell("sample")}${cell("sample")}</w:tr></w:tbl>`
async function template(table = sourceTable) {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<Types xmlns="${NS.ct}"><Default Extension="xml" ContentType="application/xml"/></Types>`)
  zip.file("word/document.xml", `<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>[Project</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t> name] — [Version] — [Date]</w:t></w:r></w:p>${heading("Requirements")}${body}${table}<w:p><w:r><w:br w:type="page"/></w:r></w:p>${heading("Repeated", 2)}${body}${heading("Repeated", 2)}${body}${heading("Unmapped")}${body}<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:pgMar w:top="1134" w:left="1134"/></w:sectPr></w:body></w:document>`)
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

  it("FLF-372: mục có ảnh gốc (sơ đồ) thay được khi bản in của mục mang lại ảnh — ảnh không mất", async () => {
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
    expect(wAll(xml, "t").map((t) => t.textContent).join("")).toContain("Club Manager — v0 — 2026-11-04")
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

  it("mismatched table schemas never guess columns or append overflow — the FlintFlow table is written as is (FLF-372)", async () => {
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

  it("FLF-378: mẫu của dự án mới (stripTemplateText) — mục chưa soạn bỏ hướng dẫn / ví dụ, bảng mẫu giữ tiêu đề bỏ dòng mẫu", async () => {
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

  it("FLF-378: mục đã soạn — bảng mẫu không được điền vẫn bỏ dòng mẫu khi stripTemplateText", async () => {
    const input = await template(), parsed = await parseDocument(input), doc = document()
    doc.sections = [{ id: "fixed:1", heading: "Requirements", number: "1", level: 1, blocks: [{ type: "paragraph", runs: runs("Drafted requirement") }] }]
    const output = await parseDocument(await writeTemplateDocx(doc, input, [{ block_id: parsed.blocks.find((b) => b.kind === "heading")!.block_id, section_id: "fixed:1" }], [], { stripTemplateText: true }))
    expect(output.blocks.some((b) => b.text === "Drafted requirement")).toBe(true)
    expect(output.blocks.find((b) => b.kind === "table")!.rows).toEqual([["A", "B"]])
  })
})
