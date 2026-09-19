import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { DocxPackage, relsPathOf } from "./package.js"
import { makeDocx, p } from "./testing/make-docx.js"
import { OoxmlError } from "./xml.js"

describe("relsPathOf", () => {
  it("part trong thư mục và gốc gói", () => {
    expect(relsPathOf("word/document.xml")).toBe("word/_rels/document.xml.rels")
    expect(relsPathOf("")).toBe("_rels/.rels")
  })
})

describe("DocxPackage", () => {
  it("mở/lưu giữ nguyên part không đụng", async () => {
    const buf = await makeDocx({ body: p("Xin chào"), extraParts: { "word/media/x.bin": "RAW-BYTES" } })
    const pkg = await DocxPackage.load(buf)
    await pkg.requireXml("word/document.xml")
    const out = await JSZip.loadAsync(await pkg.toBuffer())
    expect(await out.file("word/media/x.bin")!.async("string")).toBe("RAW-BYTES")
    expect(await out.file("word/document.xml")!.async("string")).toContain("Xin chào")
  })

  it("thêm part cập nhật content types + rels", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("a") }))
    await pkg.addXmlPart("word/extra.xml", `<x xmlns="urn:x"/>`, "application/x-test+xml")
    const id = await pkg.addRelationship("word/document.xml", "urn:type", "extra.xml")
    expect(id).toBe("rIdFF1")
    expect(await pkg.addRelationship("word/document.xml", "urn:type", "extra2.xml")).toBe("rIdFF2")
    expect(await pkg.resolveRelationship("word/document.xml", id)).toBe("word/extra.xml")
    const out = await JSZip.loadAsync(await pkg.toBuffer())
    expect(await out.file("[Content_Types].xml")!.async("string")).toContain(`PartName="/word/extra.xml"`)
    expect(await out.file("word/_rels/document.xml.rels")!.async("string")).toContain(`Target="extra.xml"`)
  })

  it("addXmlPart trên part đã có trả part cũ", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("a") }))
    const doc = await pkg.requireXml("word/document.xml")
    expect(await pkg.addXmlPart("word/document.xml", "<x/>", "t")).toBe(doc)
  })

  it("tạo rels mới khi part chưa có rels", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("a") }))
    await pkg.addRelationship("word/header1.xml", "urn:t", "../media/a.png")
    expect(await pkg.resolveRelationship("word/header1.xml", "rIdFF1")).toBe("media/a.png")
  })

  it("XML hỏng ⇒ INVALID_XML; thiếu part ⇒ PART_MISSING", async () => {
    const zip = new JSZip()
    zip.file("word/document.xml", "<w:document><w:body>")
    const pkg = await DocxPackage.load(await zip.generateAsync({ type: "nodebuffer" }))
    await expect(pkg.xml("word/document.xml")).rejects.toMatchObject({ code: "INVALID_XML" })
    await expect(pkg.requireXml("word/styles.xml")).rejects.toBeInstanceOf(OoxmlError)
  })

  it("chặn zip bomb theo tổng dung lượng giải nén", async () => {
    const zip = new JSZip()
    zip.file("big.txt", "a".repeat(10_000))
    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
    await expect(DocxPackage.load(buf, { maxUncompressedBytes: 1000 })).rejects.toMatchObject({ code: "PACKAGE_TOO_LARGE" })
  })

  it("không phải zip ⇒ lỗi", async () => {
    await expect(DocxPackage.load(Buffer.from("hello"))).rejects.toThrow()
  })

  it("partNames/has/freePartName: part mới thêm được tính ngay, tên header tiếp theo không trùng", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("a"), extraParts: { "word/header1.xml": "<x/>" } }))
    expect(pkg.partNames()).toEqual(expect.arrayContaining(["word/document.xml", "word/styles.xml", "word/header1.xml", "[Content_Types].xml"]))
    expect(pkg.partNames().some((n) => n.endsWith("/"))).toBe(false)
    expect(pkg.has("word/header2.xml")).toBe(false)
    expect(pkg.freePartName("header")).toBe("word/header2.xml")
    await pkg.addXmlPart("word/header2.xml", `<x xmlns="urn:x"/>`, "t")
    expect(pkg.has("word/header2.xml")).toBe(true)
    expect(pkg.freePartName("header")).toBe("word/header3.xml")
    expect(await pkg.xml("word/khong-co.xml")).toBeNull()
  })

  it("rels: part không có rels ⇒ []; target tuyệt đối / ./ ; id không có ⇒ null; bỏ qua id đã dùng", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: p("a"),
        extraDocRels: `<Relationship Id="rIdFF1" Type="urn:t" Target="/customXml/item1.xml"/><Relationship Id="rIdX" Type="urn:t" Target="./media/../media/b.png"/>`
      })
    )
    expect(await pkg.relationships("word/footer9.xml")).toEqual([])
    expect(await pkg.resolveRelationship("word/document.xml", "rIdFF1")).toBe("customXml/item1.xml")
    expect(await pkg.resolveRelationship("word/document.xml", "rIdX")).toBe("word/media/b.png")
    expect(await pkg.resolveRelationship("word/document.xml", "rId404")).toBeNull()
    expect(await pkg.addRelationship("word/document.xml", "urn:t", "x.xml")).toBe("rIdFF2")
    expect((await pkg.relationships("word/document.xml")).map((r) => r.id)).toEqual(["rId1", "rIdFF1", "rIdX", "rIdFF2"])
  })

  it("mở/lưu nhiều lần: part XML đã sửa được ghi lại, part không đụng giữ nguyên byte", async () => {
    const raw = `<?xml version="1.0"?><!-- giữ nguyên --><x   a="1"/>`
    const pkg = await DocxPackage.load(await makeDocx({ body: p("a"), extraParts: { "word/raw.xml": raw } }))
    const doc = await pkg.requireXml("word/document.xml")
    doc.documentElement.setAttribute("data-test", "1")
    const once = await DocxPackage.load(await pkg.toBuffer())
    const twice = await JSZip.loadAsync(await once.toBuffer())
    expect(await twice.file("word/raw.xml")!.async("string")).toBe(raw)
    expect(await twice.file("word/document.xml")!.async("string")).toContain('data-test="1"')
  })
})
