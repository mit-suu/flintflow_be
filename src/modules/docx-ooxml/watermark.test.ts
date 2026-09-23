import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { DocxPackage } from "./package.js"
import { makeDocx, p } from "./testing/make-docx.js"
import { addDraftWatermark } from "./watermark.js"
import { NS, wAll } from "./xml.js"

const HDR = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${NS.w}"><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:hdr>`
const HDR_CT = (n: number) => `<Override PartName="/word/header${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`
const HDR_REL = (n: number) => `<Relationship Id="rIdH${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header${n}.xml"/>`

const shapes = (doc: Document): number => doc.getElementsByTagNameNS("urn:schemas-microsoft-com:vml", "shape").length

describe("addDraftWatermark", () => {
  it("file không có header ⇒ tạo header default cho section đầu", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("x") }))
    const res = await addDraftWatermark(pkg)
    expect(res).toEqual({ headerParts: ["word/header1.xml"], created: 1 })
    const out = await JSZip.loadAsync(await pkg.toBuffer())
    const header = await out.file("word/header1.xml")!.async("string")
    expect(header).toContain('string="DRAFT"')
    expect(await out.file("[Content_Types].xml")!.async("string")).toContain("/word/header1.xml")
    const doc = await pkg.requireXml("word/document.xml")
    expect(wAll(doc, "headerReference")).toHaveLength(1)
  })

  it("nhiều section: chèn vào mọi header được tham chiếu, tạo header trang đầu khi có titlePg", async () => {
    const sect1 = `<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:titlePg/></w:sectPr></w:pPr></w:p>`
    const body = p("Section 1") + sect1 + p("Section 2")
    const pkg = await DocxPackage.load(
      await makeDocx({
        body,
        sectPr: `<w:sectPr><w:headerReference w:type="default" r:id="rIdH2"/></w:sectPr>`,
        extraParts: { "word/header1.xml": HDR("H1"), "word/header2.xml": HDR("H2") },
        extraDocRels: HDR_REL(1) + HDR_REL(2),
        extraContentTypes: HDR_CT(1) + HDR_CT(2)
      })
    )
    const res = await addDraftWatermark(pkg, "BẢN NHÁP")
    expect(res.created).toBe(1)
    expect(res.headerParts.sort()).toEqual(["word/header1.xml", "word/header2.xml", "word/header3.xml"])
    for (const part of res.headerParts) expect(shapes(await pkg.requireXml(part))).toBe(1)
    // nội dung header gốc còn nguyên
    expect((await pkg.requireXml("word/header1.xml")).documentElement.textContent).toContain("H1")
    const reread = await DocxPackage.load(await pkg.toBuffer())
    expect(shapes(await reread.requireXml("word/header3.xml"))).toBe(1)
  })

  it("header dùng chung cho nhiều section chỉ chèn một lần; đủ header default ⇒ không tạo mới", async () => {
    const sect1 = `<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/></w:sectPr></w:pPr></w:p>`
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: p("S1") + sect1 + p("S2"),
        sectPr: `<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/></w:sectPr>`,
        extraParts: { "word/header1.xml": HDR("H1") },
        extraDocRels: HDR_REL(1),
        extraContentTypes: HDR_CT(1)
      })
    )
    expect(await addDraftWatermark(pkg)).toEqual({ headerParts: ["word/header1.xml"], created: 0 })
    expect(shapes(await pkg.requireXml("word/header1.xml"))).toBe(1)
  })

  it("evenAndOddHeaders bật ⇒ tạo cả header default và even; text watermark được escape", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: p("x"),
        extraParts: { "word/settings.xml": `<?xml version="1.0"?><w:settings xmlns:w="${NS.w}"><w:evenAndOddHeaders/></w:settings>` }
      })
    )
    const res = await addDraftWatermark(pkg, `A&B "nháp"`)
    expect(res.created).toBe(2)
    expect(res.headerParts.sort()).toEqual(["word/header1.xml", "word/header2.xml"])
    const doc = await pkg.requireXml("word/document.xml")
    expect(wAll(doc, "headerReference").map((h) => h.getAttributeNS(NS.w, "type")).sort()).toEqual(["default", "even"])
    const out = await JSZip.loadAsync(await pkg.toBuffer())
    expect(await out.file("word/header1.xml")!.async("string")).toContain('string="A&amp;B &quot;nháp&quot;"')
  })

  it("document không có sectPr ⇒ không tạo header, không lỗi", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("x"), sectPr: "" }))
    expect(await addDraftWatermark(pkg)).toEqual({ headerParts: [], created: 0 })
  })

  it("sectPr nằm trong rPr/sectPrChange không bị coi là section", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: p("x"),
        sectPr: `<w:sectPr><w:sectPrChange w:id="1" w:author="Lan"><w:sectPr><w:titlePg/></w:sectPr></w:sectPrChange></w:sectPr>`
      })
    )
    const res = await addDraftWatermark(pkg)
    // chỉ section thật (không titlePg) ⇒ một header default
    expect(res.created).toBe(1)
  })
})
