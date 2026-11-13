import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { DocxPackage, MAIN_PART } from "../docx-ooxml/index.js"
import { makeDocx, p } from "../docx-ooxml/testing/make-docx.js"
import { NS, wAll, wKids } from "../docx-ooxml/xml.js"
import { makePng } from "../render/zip.test-helper.js"
import { createTransplanter, enforceRelsAllowList, pruneUnreferencedParts, requestFieldUpdate, transplantSections, validateDocxStructure, type TransplantRequest } from "./ooxml-transplant.js"

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml"
const rel = (id: string, type: string, target: string, external = false) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`

// Style file nguồn: id bản địa hoá, tên chuẩn của Word
const STYLES_A =
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="u2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Dsach"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Chuthich"><w:name w:val="caption"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Ghichu"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="character" w:styleId="KyTu"><w:name w:val="footnote reference"/></w:style>` +
  `<w:style w:type="table" w:styleId="TabA"><w:name w:val="Lưới A"/></w:style>`

const STYLES_B =
  `<w:style w:type="paragraph" w:default="1" w:styleId="BodyB"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/></w:style>` +
  `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/></w:style>` +
  `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>` +
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>`

const NUMBERING_A =
  `<w:abstractNum w:abstractNumId="3"><w:nsid w:val="ABCD1234"/><w:multiLevelType w:val="hybridMultilevel"/>` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Dsach"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:rPr><w:rFonts w:ascii="Symbol"/></w:rPr></w:lvl></w:abstractNum>` +
  `<w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num>`
const NUMBERING_B = `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`

const part = (xml: string, root: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} xmlns:w="${NS.w}" xmlns:r="${NS.r}">${xml}</w:${root}>`

const FOOTNOTES_A = part(
  `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:id="2"><w:p><w:pPr><w:pStyle w:val="Ghichu"/></w:pPr><w:r><w:rPr><w:rStyle w:val="KyTu"/></w:rPr><w:footnoteRef/></w:r>` +
    `<w:r><w:rPr><w:rFonts w:ascii="Comic Sans MS"/><w:sz w:val="40"/></w:rPr><w:t>Note text</w:t></w:r></w:p></w:footnote>`,
  "footnotes"
)

const drawing = (embedAttr: string, docPrId = 1) =>
  `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="100" cy="100"/><wp:docPr id="${docPrId}" name="Pic"/>` +
  `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
  `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip ${embedAttr}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`

const buildSource = (body: string, extra: { rels?: string; parts?: Record<string, string | Buffer>; contentTypes?: string } = {}) =>
  makeDocx({
    body,
    styles: STYLES_A,
    extraDocRels:
      rel("rId10", "image", "media/image1.png") +
      rel("rId11", "hyperlink", "https://example.com/spec", true) +
      rel("rId12", "hyperlink", String.raw`\\fileserver\share\doc.docx`, true) +
      rel("rId13", "footnotes", "footnotes.xml") +
      rel("rId14", "numbering", "numbering.xml") +
      rel("rId15", "oleObject", "embeddings/oleObject1.bin") +
      rel("rId16", "aFChunk", "afchunk.htm") +
      rel("rId17", "image", "file:///C:/secret.png", true) +
      (extra.rels ?? ""),
    extraParts: {
      "word/media/image1.png": makePng(4, 4),
      "word/numbering.xml": part(NUMBERING_A, "numbering"),
      "word/footnotes.xml": FOOTNOTES_A,
      "word/embeddings/oleObject1.bin": "OLE-BYTES",
      "word/afchunk.htm": "<html>chunk</html>",
      ...extra.parts
    },
    extraContentTypes:
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/word/numbering.xml" ContentType="${CT}.numbering+xml"/>` +
      `<Override PartName="/word/footnotes.xml" ContentType="${CT}.footnotes+xml"/>` +
      (extra.contentTypes ?? "")
  })

const TARGET_BODY =
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Heading B</w:t></w:r></w:p>` +
  `<w:p><w:bookmarkStart w:id="0" w:name="Intro"/><w:r><w:t>Existing</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>`

const buildTarget = () =>
  makeDocx({
    body: TARGET_BODY,
    styles: STYLES_B,
    extraDocRels: rel("rId14", "numbering", "numbering.xml"),
    extraParts: { "word/numbering.xml": part(NUMBERING_B, "numbering") },
    extraContentTypes: `<Default Extension="png" ContentType="image/png"/><Override PartName="/word/numbering.xml" ContentType="${CT}.numbering+xml"/>`
  })

const bodyOf = (doc: Document) => doc.getElementsByTagNameNS(NS.w, "body")[0]
const bodyElements = async (pkg: DocxPackage) => wKids(bodyOf(await pkg.requireXml(MAIN_PART))).filter((e) => e.localName !== "sectPr")

const setup = async (sourceBody: string, extra?: Parameters<typeof buildSource>[1]) => {
  const source = await DocxPackage.load(await buildSource(sourceBody, extra))
  const target = await DocxPackage.load(await buildTarget())
  const heading = (await bodyElements(target))[0]
  const elements = await bodyElements(source)
  return { source, target, heading, elements }
}

const text = async (buf: Buffer, name: string) => (await (await JSZip.loadAsync(buf)).file(name)!.async("string")) as string
const finish = async (target: DocxPackage) => {
  const buf = await target.toBuffer()
  return { buf, problems: await validateDocxStructure(await DocxPackage.load(buf)) }
}

const FULL_SECTION =
  `<w:p><w:pPr><w:pStyle w:val="u2"/></w:pPr><w:bookmarkStart w:id="0" w:name="Intro"/><w:r><w:t>Sub heading</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>` +
  `<w:p><w:pPr><w:spacing w:before="400"/><w:ind w:left="720"/><w:rPr><w:sz w:val="48"/></w:rPr></w:pPr>` +
  `<w:r><w:rPr><w:rFonts w:ascii="Comic Sans MS"/><w:b/><w:i/><w:color w:val="FF0000"/><w:sz w:val="48"/><w:u w:val="single"/><w:strike/></w:rPr><w:t>Styled run</w:t></w:r>` +
  `<w:r><w:rPr><w:vertAlign w:val="superscript"/><w:highlight w:val="yellow"/></w:rPr><w:t>sup</w:t></w:r></w:p>` +
  `<w:p><w:hyperlink r:id="rId11"><w:r><w:t>site</w:t></w:r></w:hyperlink><w:hyperlink r:id="rId12"><w:r><w:t>unc-link</w:t></w:r></w:hyperlink>` +
  `<w:r><w:t>with note</w:t></w:r><w:r><w:rPr><w:rStyle w:val="KyTu"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>` +
  `<w:p><w:pPr><w:pStyle w:val="Dsach"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Item one</w:t></w:r></w:p>` +
  `<w:p><w:pPr><w:pStyle w:val="Dsach"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Item two</w:t></w:r></w:p>` +
  `<w:tbl><w:tblPr><w:tblStyle w:val="TabA"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>` +
  `<w:tr><w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:shd w:fill="FF0000"/></w:tcPr>${p("Cell A1")}</w:tc><w:tc>${p("Cell B1")}</w:tc></w:tr></w:tbl>` +
  `<w:p>${drawing('r:embed="rId10"', 5)}</w:p>` +
  `<w:p><w:pPr><w:pStyle w:val="Chuthich"/></w:pPr><w:r><w:t>Figure 1</w:t></w:r></w:p>`

describe("transplantSections", () => {
  it("chép mục đủ đoạn, bảng, ảnh, danh sách, footnote, bookmark và cho ra gói hợp lệ", async () => {
    const { source, target, heading, elements } = await setup(FULL_SECTION)
    const [res] = await transplantSections(source, target, [{ key: "s1", elements, after: heading }])

    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    // Chỉ link UNC bị bỏ; mọi thứ khác chép được
    expect(res.dropped).toEqual([{ kind: "external_link", detail: String.raw`\\fileserver\share\doc.docx` }])
    expect(res.inserted).toHaveLength(elements.length)

    const { buf, problems } = await finish(target)
    expect(problems).toEqual([])
    const doc = await text(buf, "word/document.xml")
    const rels = await text(buf, "word/_rels/document.xml.rels")

    // Style theo vai trò của mẫu đích
    expect(doc).toContain('<w:pStyle w:val="Heading2"/>')
    expect(doc).toContain('<w:pStyle w:val="BodyB"/>')
    expect(doc).toContain('<w:pStyle w:val="ListParagraph"/>')
    expect(doc).toContain('<w:pStyle w:val="Caption"/>')
    expect(doc).toContain('<w:tblStyle w:val="TableGrid"/>')
    expect(doc).not.toMatch(/w:val="(u2|Dsach|Chuthich|TabA)"/)
    // Run: bỏ font / màu / cỡ / tô nền, giữ b i u strike sup
    expect(doc).not.toMatch(/Comic Sans|FF0000|w:sz |w:highlight|w:spacing|w:ind /)
    expect(doc).toMatch(/<w:b\/><w:i\/><w:u w:val="single"\/><w:strike\/>/)
    expect(doc).toContain('<w:vertAlign w:val="superscript"/>')
    expect(doc).not.toContain("w:tblBorders")
    expect(doc).not.toContain("w:shd")
    expect(doc).toContain("Cell A1")
    expect(doc).toContain("Cell B1")

    // Thứ tự: ngay sau heading đích, trước đoạn cũ của đích
    const order = [...doc.matchAll(/Heading B|Sub heading|Cell A1|Figure 1|Existing/g)].map((m) => m[0])
    expect(order).toEqual(["Heading B", "Sub heading", "Cell A1", "Figure 1", "Existing"])

    // Numbering: id mới, không đụng numId 1 của đích, bỏ liên kết style của nguồn
    const numbering = await text(buf, "word/numbering.xml")
    expect(numbering).toContain('<w:num w:numId="1">')
    expect(numbering).toContain('<w:num w:numId="2">')
    expect(numbering).toContain('w:abstractNumId="1"')
    expect(numbering).toContain("Symbol")
    expect(numbering).not.toMatch(/w:nsid|w:pStyle/)
    expect(doc.match(/<w:numId w:val="2"\/>/g)).toHaveLength(2)
    expect(doc).not.toContain('<w:numId w:val="7"/>')

    // Footnote: part mới, id mới, style đích
    const notes = await text(buf, "word/footnotes.xml")
    expect(doc).toContain('<w:footnoteReference w:id="1"/>')
    expect(notes).toContain('<w:footnote w:id="1">')
    expect(notes).toContain("Note text")
    expect(notes).toContain('<w:pStyle w:val="FootnoteText"/>')
    expect(notes).toContain('<w:rStyle w:val="FootnoteReference"/>')
    expect(notes).not.toMatch(/Comic Sans|w:sz /)

    // Ảnh: part mới + rel + docPr id không trùng
    expect(Object.keys((await JSZip.loadAsync(buf)).files)).toContain("word/media/transplant1.png")
    expect(rels).toMatch(/Type="[^"]*\/image" Target="media\/transplant1\.png"/)
    expect(doc).toMatch(/<a:blip r:embed="rIdFF\d+"/)

    // Link ngoài http(s): giữ TargetMode, link UNC không còn dấu vết
    expect(rels).toMatch(/Target="https:\/\/example\.com\/spec" TargetMode="External"/)
    expect(rels).not.toContain("fileserver")
    expect(doc).not.toContain("fileserver")
    expect(doc).toContain("unc-link")

    // Bookmark trùng tên "Intro" của đích ⇒ đổi tên, id duy nhất
    const names = [...doc.matchAll(/<w:bookmarkStart [^>]*w:name="([^"]+)"/g)].map((m) => m[1])
    expect(names.sort()).toEqual(["Intro", "Intro_2"])
    const ids = [...doc.matchAll(/<w:bookmarkStart [^>]*w:id="(\d+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(2)
  })

  it("danh sách dùng chung giữa các mục giữ cùng numId, footnote vẫn đánh id mới", async () => {
    const list = (t: string) => `<w:p><w:pPr><w:pStyle w:val="Dsach"/><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`
    const { source, target, elements } = await setup(list("one") + list("two"))
    const anchors = await bodyElements(target)
    const reqs: TransplantRequest[] = [
      { key: "a", elements: [elements[0]], after: anchors[0] },
      { key: "b", elements: [elements[1]], after: anchors[1] }
    ]
    const res = await transplantSections(source, target, reqs)
    expect(res.map((r) => r.ok)).toEqual([true, true])
    const { buf, problems } = await finish(target)
    expect(problems).toEqual([])
    expect((await text(buf, "word/numbering.xml")).match(/<w:num /g)).toHaveLength(2)
  })

  it("bỏ OLE, altChunk, ảnh ngoài, link không phải http(s), kể cả UNC; không mang theo attachedTemplate của nguồn", async () => {
    const body =
      p("keep me") +
      `<w:p><w:r><w:object><v:shape xmlns:v="urn:schemas-microsoft-com:vml" id="_x0000_i1025"/><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" Type="Embed" ProgID="Excel.Sheet.12" r:id="rId15"/></w:object></w:r></w:p>` +
      `<w:altChunk r:id="rId16"/>` +
      `<w:p>${drawing('r:link="rId17"', 9)}<w:r><w:t>after external image</w:t></w:r></w:p>` +
      `<w:p><w:hyperlink r:id="rId12"><w:r><w:t>unc</w:t></w:r></w:hyperlink></w:p>`
    const { source, target, heading, elements } = await setup(body, {
      rels: rel("rId18", "attachedTemplate", String.raw`\\fileserver\templates\evil.dotm`, true).replace(`${REL}/`, `${REL}/`),
      parts: {
        "word/settings.xml": part(`<w:attachedTemplate r:id="rId1"/>`, "settings"),
        "word/_rels/settings.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${NS.rels}">${rel("rId1", "attachedTemplate", String.raw`\\fileserver\templates\evil.dotm`, true)}</Relationships>`
      }
    })
    const [res] = await transplantSections(source, target, [{ key: "s", elements, after: heading }])
    expect(res.ok).toBe(true)
    expect(res.dropped.map((d) => d.kind).sort()).toEqual(["alt_chunk", "external_image", "external_link", "ole"])

    const { buf, problems } = await finish(target)
    expect(problems).toEqual([])
    const all = Object.keys((await JSZip.loadAsync(buf)).files)
    const joined = (await Promise.all(all.filter((n) => /\.(xml|rels)$/.test(n)).map((n) => text(buf, n)))).join("\n")
    expect(joined).toContain("keep me")
    expect(joined).toContain("after external image")
    expect(joined).not.toMatch(/OLEObject|oleObject|altChunk|aFChunk|attachedTemplate|fileserver|secret\.png|a:blip/)
    expect(all.some((n) => /embeddings|afchunk/.test(n))).toBe(false)
  })

  it("mục có field nguy hiểm báo lỗi riêng, không ghi gì vào đích và không cản mục khác", async () => {
    const bad = `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> INCLUDETEXT "\\\\evil\\x.docx" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    const uncLink = `<w:p><w:fldSimple w:instr=" HYPERLINK &quot;\\\\evil\\share&quot; "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>`
    const { source, target, elements } = await setup(bad + uncLink + FULL_SECTION)
    const anchors = await bodyElements(target)
    const before = await target.toBuffer()
    const failing = await transplantSections(source, target, [
      { key: "bad1", elements: [elements[0]], after: anchors[0] },
      { key: "bad2", elements: [elements[1]], after: anchors[0] }
    ])
    expect(failing.map((r) => [r.ok, r.error?.code])).toEqual([
      [false, "unsafe_field"],
      [false, "unsafe_field"]
    ])
    expect(failing[0].inserted).toEqual([])
    const after = await target.toBuffer()
    expect(await text(after, "word/document.xml")).toBe(await text(before, "word/document.xml"))
    expect(await text(after, "word/_rels/document.xml.rels")).toBe(await text(before, "word/_rels/document.xml.rels"))
    expect(Object.keys((await JSZip.loadAsync(after)).files)).toEqual(Object.keys((await JSZip.loadAsync(before)).files))

    const mixed = await transplantSections(source, target, [
      { key: "bad", elements: [elements[0]], after: anchors[0] },
      { key: "good", elements: elements.slice(2), after: anchors[0] }
    ])
    expect(mixed.map((r) => r.ok)).toEqual([false, true])
    expect((await finish(target)).problems).toEqual([])
  })

  it("field HYPERLINK nội bộ (\\l) hoặc http(s) vẫn được chép", async () => {
    const ok =
      `<w:p><w:fldSimple w:instr=" HYPERLINK \\l &quot;Intro&quot; "><w:r><w:t>a</w:t></w:r></w:fldSimple>` +
      `<w:fldSimple w:instr=" HYPERLINK &quot;https://example.com&quot; "><w:r><w:t>b</w:t></w:r></w:fldSimple></w:p>`
    const { source, target, heading, elements } = await setup(ok)
    const [res] = await transplantSections(source, target, [{ key: "s", elements, after: heading }])
    expect(res.ok).toBe(true)
  })

  it("đổi tên bookmark thì neo nội bộ (w:anchor, REF) đổi theo; neo block nội bộ _ff_ bị bỏ", async () => {
    const body =
      `<w:p><w:bookmarkStart w:id="3" w:name="_ff_B0001"/><w:bookmarkStart w:id="4" w:name="Intro"/><w:r><w:t>t</w:t></w:r><w:bookmarkEnd w:id="4"/><w:bookmarkEnd w:id="3"/></w:p>` +
      `<w:p><w:hyperlink w:anchor="Intro"><w:r><w:t>jump</w:t></w:r></w:hyperlink><w:r><w:instrText> REF Intro \\h </w:instrText></w:r></w:p>`
    const { source, target, heading, elements } = await setup(body)
    const [res] = await transplantSections(source, target, [{ key: "s", elements, after: heading }])
    expect(res.ok).toBe(true)
    const { buf, problems } = await finish(target)
    expect(problems).toEqual([])
    const doc = await text(buf, "word/document.xml")
    expect(doc).not.toContain("_ff_B0001")
    expect(doc).toContain('w:anchor="Intro_2"')
    expect(doc).toContain(" REF Intro_2 ")
  })

  it("không nhận nút ngoài document.xml nguồn", async () => {
    const { source, target, heading } = await setup(p("x"))
    const foreign = (await bodyElements(target))[1]
    const [res] = await transplantSections(source, target, [{ key: "s", elements: [foreign], after: heading }])
    expect(res).toMatchObject({ ok: false, error: { code: "invalid_input" } })
  })

  it("mẫu đích thiếu style cùng vai trò thì rơi về Normal và cảnh báo", async () => {
    const source = await DocxPackage.load(await buildSource(`<w:p><w:pPr><w:pStyle w:val="u1"/></w:pPr><w:r><w:t>H</w:t></w:r></w:p>`))
    const target = await DocxPackage.load(await makeDocx({ body: p("anchor"), styles: `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` }))
    const [res] = await transplantSections(source, target, [{ key: "s", elements: await bodyElements(source), after: (await bodyElements(target))[0] }])
    expect(res.ok).toBe(true)
    expect(res.warnings.join()).toContain("h1")
    expect(await text(await target.toBuffer(), "word/document.xml")).toContain('<w:pStyle w:val="Normal"/>')
  })
})

describe("enforceRelsAllowList", () => {
  it("gỡ attachedTemplate, OLE, altChunk, ảnh ngoài và link ngoài không phải http(s); giữ link http(s)", async () => {
    const body =
      `<w:p><w:hyperlink r:id="rId11"><w:r><w:t>ok</w:t></w:r></w:hyperlink><w:hyperlink r:id="rId12"><w:r><w:t>unc</w:t></w:r></w:hyperlink></w:p>` +
      `<w:p><w:r><w:object><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" r:id="rId15"/></w:object></w:r></w:p>` +
      `<w:altChunk r:id="rId16"/>` +
      `<w:p>${drawing('r:link="rId17"')}</w:p>`
    const buf = await buildSource(body, {
      rels: rel("rId19", "hyperlink", "mailto:a@b.c", true),
      parts: {
        "word/settings.xml": part(`<w:attachedTemplate r:id="rId1"/>`, "settings"),
        "word/_rels/settings.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${NS.rels}">${rel("rId1", "attachedTemplate", String.raw`\\fileserver\templates\evil.dotm`, true)}</Relationships>`
      },
      contentTypes: `<Override PartName="/word/settings.xml" ContentType="${CT}.settings+xml"/>`
    })
    const pkg = await DocxPackage.load(buf)
    const dropped = await enforceRelsAllowList(pkg)
    expect(dropped.map((d) => d.kind).sort()).toEqual(["alt_chunk", "attached_template", "external_image", "external_link", "external_link", "ole"])

    const out = await pkg.toBuffer()
    const settings = await text(out, "word/settings.xml")
    const doc = await text(out, "word/document.xml")
    expect(settings).not.toContain("attachedTemplate")
    expect(doc).not.toMatch(/OLEObject|altChunk|a:blip|fileserver/)
    expect(doc).toContain("unc") // chữ của link bị bóc vẫn còn
    expect(await text(out, "word/_rels/document.xml.rels")).toMatch(/Target="https:\/\/example\.com\/spec" TargetMode="External"/)
    expect(await text(out, "word/_rels/document.xml.rels")).not.toMatch(/mailto|oleObject|aFChunk|file:|fileserver/)
    expect(await text(out, "word/_rels/settings.xml.rels")).not.toContain("attachedTemplate")
    expect(wAll(await DocxPackage.load(out).then((x) => x.requireXml(MAIN_PART)), "hyperlink")).toHaveLength(1)
  })
})

describe("validateDocxStructure", () => {
  it("báo r:id không giải được, numId và footnote thiếu, bookmark trùng", async () => {
    const buf = await makeDocx({
      body:
        `<w:p><w:hyperlink r:id="rIdMissing"><w:r><w:t>x</w:t></w:r></w:hyperlink></w:p>` +
        `<w:p><w:pPr><w:numPr><w:numId w:val="9"/></w:numPr></w:pPr><w:r><w:footnoteReference w:id="4"/></w:r></w:p>` +
        `<w:p><w:bookmarkStart w:id="1" w:name="A"/><w:bookmarkEnd w:id="1"/><w:bookmarkStart w:id="1" w:name="A"/><w:bookmarkEnd w:id="1"/></w:p>`
    })
    const problems = (await validateDocxStructure(await DocxPackage.load(buf))).join("\n")
    expect(problems).toContain("rIdMissing")
    expect(problems).toContain("numId 9")
    expect(problems).toContain("footnoteReference 4")
    expect(problems).toContain("Trùng id bookmark 1")
    expect(problems).toContain("Trùng tên bookmark A")
  })
})

describe("transplantSections — footnotePr và độ rộng bảng", () => {
  const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:zoom w:percent="100"/><w:compat/></w:settings>`
  const buildTargetWithSettings = (margin: number) =>
    makeDocx({
      body: TARGET_BODY,
      styles: STYLES_B,
      sectPr: `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="${margin}" w:bottom="1440" w:left="${margin}"/></w:sectPr>`,
      extraDocRels: rel("rId30", "settings", "settings.xml"),
      extraParts: { "word/settings.xml": SETTINGS },
      extraContentTypes: `<Override PartName="/word/settings.xml" ContentType="${CT}.settings+xml"/>`
    })

  it("footnote part tạo mới ⇒ settings.xml khai báo footnotePr (-1, 0) trước compat", async () => {
    const source = await DocxPackage.load(await buildSource(`<w:p><w:r><w:t>x</w:t></w:r><w:r><w:rPr><w:rStyle w:val="KyTu"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>`))
    const target = await DocxPackage.load(await buildTargetWithSettings(1440))
    const heading = (await bodyElements(target))[0]
    const [res] = await transplantSections(source, target, [{ key: "s", elements: await bodyElements(source), after: heading }])
    expect(res.ok).toBe(true)
    const { buf, problems } = await finish(target)
    expect(problems).toEqual([])
    const settings = await text(buf, "word/settings.xml")
    expect(settings).toMatch(/<w:footnotePr><w:footnote w:id="-1"\/><w:footnote w:id="0"\/><\/w:footnotePr><w:compat\/>/)
  })

  it("footnote part đã có sẵn ở đích ⇒ không thêm footnotePr", async () => {
    const source = await DocxPackage.load(await buildSource(`<w:p><w:r><w:rPr><w:rStyle w:val="KyTu"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>`))
    const target = await DocxPackage.load(
      await makeDocx({
        body: TARGET_BODY,
        styles: STYLES_B,
        extraDocRels: rel("rId30", "settings", "settings.xml") + rel("rId31", "footnotes", "footnotes.xml"),
        extraParts: { "word/settings.xml": SETTINGS, "word/footnotes.xml": part(`<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>`, "footnotes") },
        extraContentTypes: `<Override PartName="/word/settings.xml" ContentType="${CT}.settings+xml"/><Override PartName="/word/footnotes.xml" ContentType="${CT}.footnotes+xml"/>`
      })
    )
    const heading = (await bodyElements(target))[0]
    await transplantSections(source, target, [{ key: "s", elements: await bodyElements(source), after: heading }])
    expect(await text(await target.toBuffer(), "word/settings.xml")).not.toContain("footnotePr")
  })

  it("bảng rộng theo trang nguồn được co theo vùng chữ của trang đích", async () => {
    // Nguồn: A4 lề 1440 ⇒ vùng chữ 9026; đích lề 2000 ⇒ 7906. Bảng 9000 ⇒ co còn ~7900
    const table = `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr>${p("a")}</w:tc><w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr>${p("b")}</w:tc></w:tr></w:tbl>`
    const source = await DocxPackage.load(
      await makeDocx({ body: table, styles: STYLES_A, sectPr: `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` })
    )
    const target = await DocxPackage.load(await buildTargetWithSettings(2000))
    const heading = (await bodyElements(target))[0]
    const [res] = await transplantSections(source, target, [{ key: "s", elements: await bodyElements(source), after: heading }])
    expect(res.ok).toBe(true)
    const doc = await text(await target.toBuffer(), "word/document.xml")
    const grid = [...doc.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]))
    expect(grid.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(7906)
    expect(grid.reduce((a, b) => a + b, 0)).toBeGreaterThan(7800)
    expect(doc).toMatch(/<w:tblW w:w="78\d\d" w:type="dxa"\/>/)
    expect([...doc.matchAll(/<w:tcW w:w="(\d+)" w:type="dxa"\/>/g)].every((m) => Number(m[1]) < 4000)).toBe(true)
  })
})

describe("transplantSections — field, r:* lạ, bookmark footnote", () => {
  const fieldRuns = (parts: string[]) =>
    `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>${parts.map((t) => `<w:r><w:instrText xml:space="preserve">${t}</w:instrText></w:r>`).join("")}<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>x</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
  const run = async (body: string, extra?: Parameters<typeof buildSource>[1]) => {
    const { source, target, heading, elements } = await setup(body, extra)
    const [res] = await transplantSections(source, target, [{ key: "s", elements, after: heading }])
    return { res, target }
  }

  it.each([
    ["INCLUDEPICTURE tách qua hai run", [" INCLUDE", String.raw`PICTURE "\\attacker\s\a.png" \d `]],
    ["INCLUDE rút gọn", [String.raw` INCLUDE "\\attacker\s\a.docx" `]],
    ["AUTOTEXT", [" AUTOTEXT x "]],
    ["INCLUDETEXT nguyên dòng", [String.raw` INCLUDETEXT "\\attacker\x.docx" `]],
    ["HYPERLINK \\l kèm đích UNC", [String.raw` HYPERLINK \l "x" "\\attacker\s" `]]
  ])("field %s ⇒ cả mục lỗi, đích không nhận gì", async (_name, parts) => {
    const { res, target } = await run(fieldRuns(parts))
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("unsafe_field")
    expect(await text(await target.toBuffer(), "word/document.xml")).not.toMatch(/INCLUDE|AUTOTEXT|attacker/)
  })

  it("field mở ở đoạn này, đóng ở đoạn sau vẫn bị chặn", async () => {
    const body =
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> INCLUDETEXT</w:instrText></w:r></w:p>` +
      `<w:p><w:r><w:instrText xml:space="preserve"> "x.docx" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    expect((await run(body)).res.error?.code).toBe("unsafe_field")
  })

  it("HYPERLINK http(s) và HYPERLINK \\l chỉ có neo nội bộ vẫn chép được", async () => {
    const body = fieldRuns([' HYPERLINK "https://example.com/a" ']) + fieldRuns([' HYPERLINK \\l "Intro" '])
    expect((await run(body)).res.ok).toBe(true)
  })

  it("w:subDoc trong đoạn bị bỏ, kể cả khi r:id trùng một rel của đích", async () => {
    const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    const src = await DocxPackage.load(
      await buildSource(`<w:p><w:subDoc r:id="rId5"/></w:p><w:p><w:subDoc r:id="rId9"/></w:p>`, {
        rels: `<Relationship Id="rId5" Type="${R}/subDocument" Target="file:///x.docx" TargetMode="External"/><Relationship Id="rId9" Type="${R}/subDocument" Target="file:///y.docx" TargetMode="External"/>`
      })
    )
    const target = await DocxPackage.load(
      await makeDocx({ body: TARGET_BODY, styles: STYLES_B, extraDocRels: rel("rId9", "image", "media/x.png"), extraParts: { "word/media/x.png": makePng(2, 2) }, extraContentTypes: `<Default Extension="png" ContentType="image/png"/>` })
    )
    const [res] = await transplantSections(src, target, [{ key: "s", elements: await bodyElements(src), after: (await bodyElements(target))[0] }])
    expect(res.ok).toBe(true)
    expect(res.dropped.filter((d) => d.kind === "sub_document")).toHaveLength(2)
    const { buf, problems } = await finish(target)
    expect(await text(buf, "word/document.xml")).not.toContain("subDoc")
    expect(problems).toEqual([])
  })

  it("phần tử lạ mang r:id chưa được xử lý bị bỏ khỏi khối", async () => {
    const { res, target } = await run(`<w:p><w:r><w:t>keep me</w:t></w:r><w:r><x:weird xmlns:x="urn:x" r:id="rId5"/></w:r></w:p>`)
    expect(res.ok).toBe(true)
    expect(res.dropped.some((d) => d.kind === "unsupported_part")).toBe(true)
    const doc = await text(await target.toBuffer(), "word/document.xml")
    expect(doc).toContain("keep me")
    expect(doc).not.toContain("weird")
  })

  it("bookmark trong footnote được cấp id / tên mới, bỏ neo nội bộ; không đổi chữ ngoài tham chiếu bookmark", async () => {
    const footnotes = part(
      `<w:footnote w:id="2"><w:p><w:bookmarkStart w:id="0" w:name="Intro"/><w:r><w:t>Note</w:t></w:r><w:bookmarkEnd w:id="0"/><w:bookmarkStart w:id="1" w:name="_ff_B0007"/><w:bookmarkEnd w:id="1"/></w:p></w:footnote>`,
      "footnotes"
    )
    const body =
      `<w:p><w:bookmarkStart w:id="0" w:name="Intro"/><w:r><w:t>Body</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>` +
      `<w:p><w:r><w:rPr><w:rStyle w:val="KyTu"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>` +
      fieldRuns([' HYPERLINK "https://example.com/Intro" ']) +
      fieldRuns([" REF Intro \\h "])
    const { res, target } = await run(body, { parts: { "word/footnotes.xml": footnotes } })
    expect(res.ok, JSON.stringify(res.error)).toBe(true)
    const buf = await target.toBuffer()
    const doc = await text(buf, "word/document.xml")
    const notes = await text(buf, "word/footnotes.xml")
    expect(notes).not.toContain("_ff_")
    const names = [...(doc + notes).matchAll(/<w:bookmarkStart [^>]*w:name="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(names).size).toBe(names.length)
    const ids = [...(doc + notes).matchAll(/<w:bookmarkStart [^>]*w:id="(\d+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
    // Đối số REF đổi theo bookmark vừa đổi tên; URL giữ nguyên
    expect(doc).toContain("https://example.com/Intro")
    expect(doc).toMatch(/REF Intro_\d \\h/)
  })
})

describe("enforceRelsAllowList / pruneUnreferencedParts", () => {
  it("gỡ rel vbaProject / activeX và dọn part mồ côi cùng Override", async () => {
    const MS = "http://schemas.microsoft.com/office/2006/relationships"
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: TARGET_BODY,
        styles: STYLES_B,
        extraDocRels: `<Relationship Id="rId40" Type="${MS}/vbaProject" Target="vbaProject.bin"/><Relationship Id="rId41" Type="${REL}/oleObject" Target="embeddings/oleObject1.bin"/>`,
        extraParts: { "word/vbaProject.bin": "VBA", "word/embeddings/oleObject1.bin": "OLE" },
        extraContentTypes: `<Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>`
      })
    )
    const dropped = await enforceRelsAllowList(pkg)
    expect(dropped.map((d) => d.kind)).toEqual(expect.arrayContaining(["ole"]))
    const removed = await pruneUnreferencedParts(pkg)
    expect(removed.sort()).toEqual(["word/embeddings/oleObject1.bin", "word/vbaProject.bin"])
    const buf = await pkg.toBuffer()
    expect(Object.keys((await JSZip.loadAsync(buf)).files)).not.toContain("word/vbaProject.bin")
    expect(await text(buf, "[Content_Types].xml")).not.toContain("vbaProject")
    expect(await validateDocxStructure(await DocxPackage.load(buf))).toEqual([])
  })

  it("quan hệ rIdFF không còn được trỏ tới bị gỡ cùng ảnh của nó", async () => {
    const pkg = await DocxPackage.load(await buildTarget())
    await pkg.addBinaryPart("word/media/transplant9.png", makePng(2, 2), "image/png")
    await pkg.addRelationship(MAIN_PART, `${REL}/image`, "media/transplant9.png")
    const removed = await pruneUnreferencedParts(pkg)
    expect(removed).toEqual(["word/media/transplant9.png"])
    expect(await text(await pkg.toBuffer(), "word/_rels/document.xml.rels")).not.toContain("transplant9")
  })

  it("không đụng part còn được tham chiếu", async () => {
    const pkg = await DocxPackage.load(await buildTarget())
    expect(await pruneUnreferencedParts(pkg)).toEqual([])
  })
})

describe("createTransplanter", () => {
  it("hai lần chạy dùng chung numId / ảnh: cùng numId nguồn ⇒ cùng numId đích, ảnh không nhân bản", async () => {
    const list = `<w:p><w:pPr><w:pStyle w:val="Dsach"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>`
    const body = list + `<w:p>${drawing('r:embed="rId10"', 5)}</w:p>`
    const source = await DocxPackage.load(await buildSource(body))
    const target = await DocxPackage.load(await buildTarget())
    const els = await bodyElements(source)
    const heading = (await bodyElements(target))[0]
    const transplanter = await createTransplanter(source, target)
    const a = await transplanter.run({ key: "a", elements: els, after: heading })
    const b = await transplanter.run({ key: "b", elements: els, after: a.inserted[a.inserted.length - 1] })
    expect(a.ok && b.ok).toBe(true)
    const buf = await target.toBuffer()
    const doc = await text(buf, "word/document.xml")
    expect(new Set([...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1])).size).toBe(1)
    expect(Object.keys((await JSZip.loadAsync(buf)).files).filter((n) => n.startsWith("word/media/") && n.endsWith(".png"))).toHaveLength(1)
    expect(await validateDocxStructure(await DocxPackage.load(buf))).toEqual([])
  })
})

describe("requestFieldUpdate — mục lục chép theo file mẫu", () => {
  const fld = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
  const instr = (text: string) => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`
  // TOC phức nhiều đoạn, mỗi dòng có PAGEREF lồng; thêm một field PAGE không phải mục lục và một fldSimple TOC
  const body =
    `<w:p>${fld("begin")}${instr(' TOC \o "1-3" \h ')}${fld("separate")}<w:r><w:t>Status Report</w:t></w:r>${fld("begin")}${instr(" PAGEREF _Toc1 \h ")}${fld("separate")}<w:r><w:t>3</w:t></w:r>${fld("end")}</w:p>` +
    `<w:p><w:r><w:t>&lt;&lt;Feature Name 1&gt;&gt;</w:t></w:r>${fld("begin")}${instr(" PAGEREF _Toc2 \h ")}${fld("separate")}<w:r><w:t>Error! Bookmark not defined.</w:t></w:r>${fld("end")}</w:p>` +
    `<w:p>${fld("end")}</w:p>` +
    `<w:p>${fld("begin")}${instr(" PAGE ")}${fld("separate")}<w:r><w:t>1</w:t></w:r>${fld("end")}</w:p>` +
    `<w:p><w:fldSimple w:instr=" TOC \o &quot;1-2&quot; "><w:r><w:t>cũ</w:t></w:r></w:fldSimple></w:p>`
  const settingsPart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${NS.w}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:footnotePr><w:footnote w:id="-1"/></w:footnotePr><w:compat/></w:settings>`

  it("đánh dấu field TOC dirty (không đụng PAGEREF / PAGE) và bật updateFields đúng vị trí schema", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({ body, extraParts: { "word/settings.xml": settingsPart }, extraDocRels: rel("rId9", "settings", "settings.xml"), extraContentTypes: `<Override PartName="/word/settings.xml" ContentType="${CT}.settings+xml"/>` })
    )
    expect(await requestFieldUpdate(pkg)).toEqual({ tocFields: 2 })
    const out = await DocxPackage.load(await pkg.toBuffer())
    const doc = (await out.xml(MAIN_PART))!
    const begins = wAll(doc, "fldChar").filter((f) => f.getAttributeNS(NS.w, "fldCharType") === "begin")
    expect(begins.map((b) => b.getAttributeNS(NS.w, "dirty"))).toEqual(["true", "", "", ""])
    expect(wAll(doc, "fldSimple")[0].getAttributeNS(NS.w, "dirty")).toBe("true")
    const settings = (await out.xml("word/settings.xml"))!
    expect(wKids(settings.documentElement).map((k) => k.localName)).toEqual(["zoom", "defaultTabStop", "updateFields", "footnotePr", "compat"])
    // Gọi lại không nhân đôi updateFields
    await requestFieldUpdate(out)
    expect(wKids((await out.xml("word/settings.xml"))!.documentElement).filter((k) => k.localName === "updateFields")).toHaveLength(1)
  })

  it("không có settings.xml ⇒ vẫn đánh dấu field, không lỗi", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body }))
    expect(await requestFieldUpdate(pkg)).toEqual({ tocFields: 2 })
    expect(await pkg.xml("word/settings.xml")).toBeNull()
  })
})

describe("transplantSections — headingShift (mẫu đích lồng sâu hơn file cũ, test tay 11/11)", () => {
  it("heading trong khối dịch cấp theo headingShift, kẹp 1–9; đoạn thường không đổi", async () => {
    const body = `<w:p><w:pPr><w:pStyle w:val="u1"/></w:pPr><w:r><w:t>3.2 Authentication</w:t></w:r></w:p>` + p("Screens: SCR-01") + `<w:p><w:pPr><w:pStyle w:val="u2"/></w:pPr><w:r><w:t>3.2.1 Log in</w:t></w:r></w:p>`
    const { source, target, heading, elements } = await setup(body)
    const [res] = await transplantSections(source, target, [{ key: "s", elements, after: heading, headingShift: 1 }])
    expect(res.ok).toBe(true)
    const styles = res.inserted.map((n) => n.getElementsByTagNameNS(NS.w, "pStyle")[0]?.getAttributeNS(NS.w, "val") ?? null)
    // h1 → Heading2, đoạn thường → style thân của đích (không phải heading), h2 → h3 (đích không có Heading3 ⇒ không phải Heading1/2)
    expect(styles[0]).toBe("Heading2")
    expect(styles[1]).not.toMatch(/^Heading/)
    expect(styles[2]).not.toBe("Heading1")
    expect(styles[2]).not.toBe("Heading2")
  })

  it("không truyền headingShift ⇒ giữ cấp như trước", async () => {
    const { source, target, heading, elements } = await setup(`<w:p><w:pPr><w:pStyle w:val="u1"/></w:pPr><w:r><w:t>H</w:t></w:r></w:p>`)
    const [res] = await transplantSections(source, target, [{ key: "s", elements, after: heading }])
    expect(res.inserted[0].getElementsByTagNameNS(NS.w, "pStyle")[0]?.getAttributeNS(NS.w, "val")).toBe("Heading1")
  })
})

