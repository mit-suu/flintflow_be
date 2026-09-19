import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { readBlocks } from "./blocks.js"
import { addComment, listComments, removeComments } from "./comments.js"
import { DocxPackage } from "./package.js"
import { commentParagraph } from "./revisions.js"
import { makeDocx, p, table } from "./testing/make-docx.js"
import { CONTENT_TYPE, NS, REL_TYPE, wAll, wAttr } from "./xml.js"

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

  it("file đã có comments.xml của Word: id nối tiếp id lớn nhất, không thêm rels/content type lần hai", async () => {
    const existing =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${NS.w}">` +
      `<w:comment w:id="4" w:author="Lan"><w:p><w:r><w:t>Của khách</w:t></w:r></w:p></w:comment></w:comments>`
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: `<w:p><w:commentRangeStart w:id="4"/><w:r><w:t>A</w:t></w:r><w:commentRangeEnd w:id="4"/><w:r><w:commentReference w:id="4"/></w:r></w:p>` + p("B"),
        extraParts: { "word/comments.xml": existing },
        extraDocRels: `<Relationship Id="rIdC" Type="${REL_TYPE.comments}" Target="comments.xml"/>`,
        extraContentTypes: `<Override PartName="/word/comments.xml" ContentType="${CONTENT_TYPE.comments}"/>`
      })
    )
    const blocks = await readBlocks(pkg)
    expect(await addComment(pkg, blocks[1].element, "Của CR", { author: "CR-003", date: DATE })).toBe("5")
    const zip = await JSZip.loadAsync(await pkg.toBuffer())
    const rels = await zip.file("word/_rels/document.xml.rels")!.async("string")
    expect(rels.match(/comments\.xml/g)).toHaveLength(1)
    const ct = await zip.file("[Content_Types].xml")!.async("string")
    expect(ct.match(/\/word\/comments\.xml/g)).toHaveLength(1)
    expect((await listComments(pkg)).map((c) => [c.id, c.author])).toEqual([
      ["4", "Lan"],
      ["5", "CR-003"]
    ])
  })

  it("commentRangeStart mồ côi trong document (không có trong comments.xml) ⇒ id mới không trùng", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({ body: `<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>A</w:t></w:r><w:commentRangeEnd w:id="7"/></w:p>` + p("B") })
    )
    const blocks = await readBlocks(pkg)
    expect(await addComment(pkg, blocks[1].element, "x", { author: "CR-001", date: DATE })).toBe("8")
  })

  it("range bao đúng block: đoạn không pPr (start đầu đoạn), ô bảng (range nằm trong ô), date/author ghi đúng", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("Không pPr") + table([["Ô một", "Ô hai"]]) }))
    const blocks = await readBlocks(pkg)
    await addComment(pkg, blocks[0].element, "a", { author: "CR-001", date: DATE })
    expect(Array.from(blocks[0].element.childNodes).map((n) => (n as Element).localName)).toEqual(["commentRangeStart", "r", "commentRangeEnd", "r"])

    const cell = blocks.find((b) => b.kind === "table_cell" && b.text === "Ô hai")!
    const id = await addComment(pkg, cell.element, "b", { author: "CR-001", date: DATE })
    expect(await commentParagraph(pkg, id)).toBe(cell.element)
    const doc = await pkg.requireXml("word/document.xml")
    const start = wAll(doc, "commentRangeStart").find((s) => wAttr(s, "id") === id)!
    expect((start.parentNode!.parentNode as Element).localName).toBe("tc")
    // ô kia không bị bao
    const other = blocks.find((b) => b.kind === "table_cell" && b.text === "Ô một")!
    expect(wAll(other.element, "commentRangeStart")).toHaveLength(0)

    const cdoc = await pkg.requireXml("word/comments.xml")
    expect(wAll(cdoc, "comment").map((c) => [wAttr(c, "author"), wAttr(c, "date")])).toEqual([
      ["CR-001", "2026-09-18T10:00:00Z"],
      ["CR-001", "2026-09-18T10:00:00Z"]
    ])
    // block vẫn đọc ra text cũ (comment không đổi text)
    expect((await readBlocks(await DocxPackage.load(await pkg.toBuffer()))).map((b) => b.text)).toEqual(blocks.map((b) => b.text))
  })

  it("removeComments giữ run có nội dung khác bên cạnh commentReference", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>A</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:t>B</w:t><w:commentReference w:id="0"/></w:r></w:p>`,
        extraParts: {
          "word/comments.xml": `<?xml version="1.0"?><w:comments xmlns:w="${NS.w}"><w:comment w:id="0" w:author="CR-009"><w:p/></w:comment></w:comments>`
        }
      })
    )
    expect(await removeComments(pkg, /^CR-\d+$/)).toBe(1)
    const [b] = await readBlocks(pkg)
    expect(b.text).toBe("AB")
    expect(wAll(b.element, "commentReference")).toHaveLength(0)
  })
})
