import { describe, expect, it } from "vitest"
import { acceptAll } from "./accept-all.js"
import { readBlocks } from "./blocks.js"
import { addComment, listComments } from "./comments.js"
import { DocxPackage } from "./package.js"
import { makeDocx, p, table } from "./testing/make-docx.js"
import { RevisionIds, applyEdit } from "./track-changes.js"
import { wAll, wAttr } from "./xml.js"

const DATE = new Date("2026-09-18T10:00:00Z")

describe("acceptAll", () => {
  it("bỏ w:del/moveFrom, bóc w:ins/moveTo, bỏ *PrChange; giữ bookmark neo", async () => {
    const body =
      `<w:p><w:bookmarkStart w:id="0" w:name="_ff_B0001"/><w:bookmarkEnd w:id="0"/>` +
      `<w:r><w:rPr><w:b/><w:rPrChange w:id="9" w:author="CR-001"><w:rPr/></w:rPrChange></w:rPr><w:t xml:space="preserve">Keep </w:t></w:r>` +
      `<w:del w:id="1" w:author="CR-001"><w:r><w:delText>old</w:delText></w:r></w:del>` +
      `<w:ins w:id="2" w:author="CR-001"><w:r><w:t>new</w:t></w:r></w:ins>` +
      `<w:moveFrom w:id="3" w:author="CR-001"><w:r><w:t>gone</w:t></w:r></w:moveFrom>` +
      `<w:moveTo w:id="4" w:author="CR-001"><w:r><w:t xml:space="preserve"> moved</w:t></w:r></w:moveTo></w:p>`
    const pkg = await DocxPackage.load(await makeDocx({ body }))
    const res = await acceptAll(pkg)
    expect(res.revisions).toBe(5)
    const doc = await pkg.requireXml("word/document.xml")
    for (const local of ["ins", "del", "moveFrom", "moveTo", "rPrChange", "delText"]) expect(wAll(doc, local)).toHaveLength(0)
    const [b] = await readBlocks(pkg)
    expect(b.text).toBe("Keep new moved")
    expect(b.bookmark).toBe("_ff_B0001")
  })

  it("dấu đoạn bị xoá ⇒ gộp với đoạn sau; hàng bảng bị xoá ⇒ bỏ hàng", async () => {
    const body =
      `<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="CR-001"/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Đầu </w:t></w:r></w:p>` +
      p("cuối") +
      `<w:tbl><w:tr><w:trPr><w:del w:id="2" w:author="CR-001"/></w:trPr><w:tc>${p("xoá")}</w:tc></w:tr><w:tr><w:tc>${p("giữ")}</w:tc></w:tr></w:tbl>`
    const pkg = await DocxPackage.load(await makeDocx({ body }))
    await acceptAll(pkg)
    const blocks = await readBlocks(pkg)
    expect(blocks.map((b) => b.text)).toEqual(["Đầu cuối", "giữ", "giữ"])
  })

  it("bỏ comment của CR, giữ comment khác (theo mẫu truyền vào)", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("A") + p("B") }))
    const blocks = await readBlocks(pkg)
    await addComment(pkg, blocks[0].element, "x", { author: "CR-001", date: DATE })
    await addComment(pkg, blocks[1].element, "y", { author: "Reviewer", date: DATE })
    const res = await acceptAll(pkg)
    expect(res.comments).toBe(1)
    expect((await listComments(pkg)).map((c) => c.author)).toEqual(["Reviewer"])
  })

  it("xử lý cả header/footer", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: p("x"),
        extraParts: {
          "word/header1.xml": `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:ins w:id="1" w:author="CR-001"><w:r><w:t>H</w:t></w:r></w:ins></w:p></w:hdr>`
        }
      })
    )
    const res = await acceptAll(pkg)
    expect(res.parts).toContain("word/header1.xml")
    expect(wAll(await pkg.requireXml("word/header1.xml"), "ins")).toHaveLength(0)
  })

  it("bản ghi của CR (applyEdit + addComment) ⇒ bản sạch không còn w:ins/w:del/comment FlintFlow, text = text mới, đọc lại được", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("The system shall respond within 2 seconds.") + table([["UC-01", "Register"]]) + p("Ghi chú") }))
    const blocks = await readBlocks(pkg)
    const doc = await pkg.requireXml("word/document.xml")
    const who = { author: "CR-001", date: DATE, ids: new RevisionIds(doc) }
    applyEdit(blocks[0].element, "The system shall respond within 2 seconds.", "The system shall respond within 1 second.", who)
    applyEdit(blocks.find((b) => b.text === "Register" && b.kind === "table_cell")!.element, "Register", "Register account", who)
    await addComment(pkg, blocks[blocks.length - 1].element, "Kiểm lại", { author: "CR-001", date: DATE })
    await addComment(pkg, blocks[0].element, "Của người đọc", { author: "Reviewer", date: DATE })

    const res = await acceptAll(pkg)
    expect(res.comments).toBe(1)
    const clean = await DocxPackage.load(await pkg.toBuffer())
    const cdoc = await clean.requireXml("word/document.xml")
    for (const local of ["ins", "del", "delText"]) expect(wAll(cdoc, local)).toHaveLength(0)
    expect((await listComments(clean)).map((c) => c.author)).toEqual(["Reviewer"])
    // chỉ còn range + reference của comment Reviewer
    expect(wAll(cdoc, "commentReference").map((c) => wAttr(c, "id"))).toEqual(["1"])
    expect((await readBlocks(clean)).map((b) => b.text)).toEqual([
      "The system shall respond within 1 second.",
      "UC-01 | Register account",
      "UC-01",
      "Register account",
      "Ghi chú"
    ])
  })

  it("dấu ins/del định dạng trong rPr + hàng bảng được chèn (trPr/ins) + pPrChange/numberingChange ⇒ bỏ dấu, giữ nội dung", async () => {
    const body =
      `<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="CR-001"/></w:rPr><w:pPrChange w:id="2" w:author="CR-001"><w:pPr/></w:pPrChange></w:pPr><w:r><w:t>Giữ</w:t></w:r></w:p>` +
      `<w:tbl><w:tr><w:trPr><w:ins w:id="3" w:author="CR-001"/></w:trPr><w:tc>${p("Hàng mới")}</w:tc></w:tr></w:tbl>` +
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/><w:numberingChange w:id="4" w:author="CR-001"/></w:numPr></w:pPr><w:r><w:t>Mục</w:t></w:r></w:p>`
    const pkg = await DocxPackage.load(await makeDocx({ body }))
    const res = await acceptAll(pkg)
    expect(res.revisions).toBe(4)
    const doc = await pkg.requireXml("word/document.xml")
    for (const local of ["ins", "pPrChange", "numberingChange"]) expect(wAll(doc, local)).toHaveLength(0)
    expect((await readBlocks(pkg)).map((b) => b.text)).toEqual(["Giữ", "Hàng mới", "Hàng mới", "Mục"])
  })

  it("file không có revision/comment ⇒ 0; mẫu author tuỳ chọn", async () => {
    const plain = await DocxPackage.load(await makeDocx({ body: p("x") }))
    expect(await acceptAll(plain)).toEqual({ parts: ["word/document.xml"], revisions: 0, comments: 0 })

    const pkg = await DocxPackage.load(await makeDocx({ body: p("A") + p("B") }))
    const blocks = await readBlocks(pkg)
    await addComment(pkg, blocks[0].element, "x", { author: "CR-001", date: DATE })
    await addComment(pkg, blocks[1].element, "y", { author: "Bot", date: DATE })
    expect((await acceptAll(pkg, { dropCommentAuthors: /^Bot$/ })).comments).toBe(1)
    expect((await listComments(pkg)).map((c) => c.author)).toEqual(["CR-001"])
  })

  it("dấu đoạn bị xoá ở đoạn cuối (không có đoạn kế) ⇒ chỉ bỏ dấu, giữ đoạn", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({ body: `<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="CR-001"/></w:rPr></w:pPr><w:r><w:t>Cuối</w:t></w:r></w:p>` })
    )
    await acceptAll(pkg)
    expect((await readBlocks(pkg)).map((b) => b.text)).toEqual(["Cuối"])
  })
})
