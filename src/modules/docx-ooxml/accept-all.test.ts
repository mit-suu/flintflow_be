import { describe, expect, it } from "vitest"
import { acceptAll } from "./accept-all.js"
import { readBlocks } from "./blocks.js"
import { addComment, listComments } from "./comments.js"
import { DocxPackage } from "./package.js"
import { makeDocx, p } from "./testing/make-docx.js"
import { wAll } from "./xml.js"

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
})
