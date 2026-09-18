import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { readBlocks } from "./blocks.js"
import { addComment, listComments, removeComments } from "./comments.js"
import { DocxPackage } from "./package.js"
import { commentParagraph } from "./revisions.js"
import { makeDocx, p } from "./testing/make-docx.js"
import { wAll, wAttr } from "./xml.js"

const DATE = new Date("2026-09-18T10:00:00Z")

describe("comments", () => {
  it("comment đầu tiên tạo comments.xml + rels + content type; comment thứ hai tăng id", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("Đoạn một") + p("Đoạn hai") }))
    const blocks = await readBlocks(pkg)
    expect(await listComments(pkg)).toEqual([])
    const id1 = await addComment(pkg, blocks[0].element, "Cần xác nhận với khách hàng", { author: "CR-001", date: DATE })
    const id2 = await addComment(pkg, blocks[1].element, "Dòng 1\nDòng 2", { author: "CR-002", date: DATE, initials: "CR" })
    expect([id1, id2]).toEqual(["0", "1"])

    const out = await DocxPackage.load(await pkg.toBuffer())
    expect(await listComments(out)).toEqual([
      { id: "0", author: "CR-001", text: "Cần xác nhận với khách hàng" },
      { id: "1", author: "CR-002", text: "Dòng 1\nDòng 2" }
    ])
    const zip = await JSZip.loadAsync(await pkg.toBuffer())
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain("/word/comments.xml")
    expect(await zip.file("word/_rels/document.xml.rels")!.async("string")).toContain('Target="comments.xml"')
    const cdoc = await out.requireXml("word/comments.xml")
    expect(wAll(cdoc, "comment").map((c) => wAttr(c, "initials"))).toEqual(["FF", "CR"])
  })

  it("range bao đúng đoạn: start sau pPr, end + reference cuối đoạn", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("Có pPr", `<w:jc w:val="center"/>`) }))
    const [b] = await readBlocks(pkg)
    await addComment(pkg, b.element, "x", { author: "CR-001", date: DATE })
    const names = Array.from(b.element.childNodes).map((n) => (n as Element).localName)
    expect(names).toEqual(["pPr", "commentRangeStart", "r", "commentRangeEnd", "r"])
    expect(await commentParagraph(pkg, "0")).toBe(b.element)
    expect(await commentParagraph(pkg, "9")).toBeNull()
  })

  it("removeComments chỉ xoá comment khớp author, gỡ range + run reference", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("A") + p("B") }))
    const blocks = await readBlocks(pkg)
    await addComment(pkg, blocks[0].element, "của CR", { author: "CR-001", date: DATE })
    await addComment(pkg, blocks[1].element, "của người", { author: "Lan", date: DATE })
    expect(await removeComments(pkg, /^CR-\d+$/)).toBe(1)
    expect((await listComments(pkg)).map((c) => c.author)).toEqual(["Lan"])
    const doc = await pkg.requireXml("word/document.xml")
    expect(wAll(doc, "commentReference").map((c) => wAttr(c, "id"))).toEqual(["1"])
    expect(wAll(blocks[0].element, "r")).toHaveLength(1)
    expect(await removeComments(pkg, /^CR-\d+$/)).toBe(0)
  })

  it("file không có comments.xml ⇒ removeComments = 0", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("A") }))
    expect(await removeComments(pkg, /./)).toBe(0)
  })
})
