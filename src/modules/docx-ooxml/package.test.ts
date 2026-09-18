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
})
