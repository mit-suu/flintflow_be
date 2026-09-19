import { describe, expect, it } from "vitest"
import { acceptAll } from "./accept-all.js"
import { readBlocks } from "./blocks.js"
import { DocxPackage } from "./package.js"
import { makeDocx, p, table } from "./testing/make-docx.js"
import { paragraphText } from "./text.js"
import { RevisionIds, applyEdit, diffWords, toWDate, tokenize } from "./track-changes.js"
import { serializeXml, wAll, wAttr } from "./xml.js"

const DATE = new Date("2026-09-18T10:00:00.123Z")

const setup = async (body: string) => {
  const pkg = await DocxPackage.load(await makeDocx({ body }))
  const doc = await pkg.requireXml("word/document.xml")
  const blocks = await readBlocks(pkg)
  const who = { author: "CR-001", date: DATE, ids: new RevisionIds(doc) }
  return { pkg, doc, blocks, who }
}

/** Text sau Reject all (bỏ ins, giữ del) để kiểm bản gốc còn nguyên. */
const rejectedText = (el: Element): string => {
  const clone = el.cloneNode(true) as Element
  for (const ins of wAll(clone, "ins")) ins.parentNode!.removeChild(ins)
  for (const del of wAll(clone, "del")) {
    for (const dt of wAll(del, "delText")) {
      const t = dt.ownerDocument.createElementNS(dt.namespaceURI, "w:t")
      t.textContent = dt.textContent
      dt.parentNode!.replaceChild(t, dt)
    }
    while (del.firstChild) del.parentNode!.insertBefore(del.firstChild, del)
    del.parentNode!.removeChild(del)
  }
  return paragraphText(clone)
}

describe("diffWords", () => {
  it("tách token chữ, khoảng trắng, dấu câu (có tiếng Việt)", () => {
    expect(tokenize("Người dùng, đăng nhập.")).toEqual(["Người", " ", "dùng", ",", " ", "đăng", " ", "nhập", "."])
  })

  it("hunk tối thiểu: sửa giữa, đầu, cuối; không đổi ⇒ rỗng", () => {
    expect(diffWords("The user can log in.", "The user can sign in.")).toEqual([{ start: 13, end: 16, deleted: "log", inserted: "sign" }])
    expect(diffWords("one lesson here", "three lessons here")).toEqual([
      { start: 0, end: 3, deleted: "one", inserted: "three" },
      { start: 4, end: 10, deleted: "lesson", inserted: "lessons" }
    ])
    expect(diffWords("abc", "abc def")).toEqual([{ start: 3, end: 3, deleted: "", inserted: " def" }])
    expect(diffWords("x y", "x y")).toEqual([])
    expect(diffWords("a  b", "a b")).toEqual([])
  })
})

describe("applyEdit", () => {
  it("sửa giữa đoạn nhiều run: giữ rPr, author/date đúng, Accept/Reject đúng text", async () => {
    const { doc, blocks, who } = await setup(
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">The system </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>shall send an email</w:t></w:r><w:r><w:t xml:space="preserve"> within 5 minutes.</w:t></w:r></w:p>`
    )
    const para = blocks[0].element
    const hunks = applyEdit(para, "The system shall send an email within 5 minutes.", "The system shall send an SMS within 2 minutes.", who)
    expect(hunks.map((h) => [h.deleted, h.inserted])).toEqual([
      ["email", "SMS"],
      ["5", "2"]
    ])
    expect(paragraphText(para)).toBe("The system shall send an SMS within 2 minutes.")
    expect(rejectedText(para)).toBe("The system shall send an email within 5 minutes.")
    const ins = wAll(doc, "ins")
    expect(ins.map((i) => [wAttr(i, "author"), wAttr(i, "date")])).toEqual([
      ["CR-001", toWDate(DATE)],
      ["CR-001", toWDate(DATE)]
    ])
    expect(toWDate(DATE)).toBe("2026-09-18T10:00:00Z")
    // "SMS" nằm trong run in nghiêng như "email"
    expect(wAll(ins[0], "i")).toHaveLength(1)
    const ids = [...wAll(doc, "ins"), ...wAll(doc, "del")].map((x) => wAttr(x, "id"))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("chèn đầu/cuối đoạn, xoá hết, đoạn rỗng", async () => {
    const { blocks, who } = await setup(p("Hello world") + p("Bye") + `<w:p><w:r><w:drawing/></w:r></w:p>`)
    applyEdit(blocks[0].element, "Hello world", "Well, Hello world again", who)
    expect(paragraphText(blocks[0].element)).toBe("Well, Hello world again")
    expect(rejectedText(blocks[0].element)).toBe("Hello world")
    applyEdit(blocks[1].element, "Bye", "", who)
    expect(paragraphText(blocks[1].element)).toBe("")
    expect(rejectedText(blocks[1].element)).toBe("Bye")
    applyEdit(blocks[2].element, "", "Caption mới", who)
    expect(paragraphText(blocks[2].element)).toBe("Caption mới")
  })

  it("ô bảng và list item", async () => {
    const { blocks, who } = await setup(
      table([["UC-01", "Register account"]]) + p("Gửi email xác nhận", `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`)
    )
    const cell = blocks.find((b) => b.text === "Register account")!
    applyEdit(cell.element, "Register account", "Register user account", who)
    expect(paragraphText(cell.element)).toBe("Register user account")
    const item = blocks.find((b) => b.kind === "list_item")!
    applyEdit(item.element, "Gửi email xác nhận", "Gửi SMS xác nhận", who)
    expect(paragraphText(item.element)).toBe("Gửi SMS xác nhận")
    expect(wAll(item.element, "numPr")).toHaveLength(1)
  })

  it("sửa lần hai trên đoạn đã có Track Changes của CR trước: không lồng w:ins trong w:ins", async () => {
    const { doc, blocks, who } = await setup(p("Login with password"))
    const para = blocks[0].element
    applyEdit(para, "Login with password", "Login with password or OTP", who)
    const who2 = { author: "CR-002", date: DATE, ids: new RevisionIds(doc) }
    applyEdit(para, "Login with password or OTP", "Login with OTP only", who2)
    expect(paragraphText(para)).toBe("Login with OTP only")
    for (const ins of wAll(doc, "ins")) expect(wAll(ins, "ins")).toHaveLength(0)
    expect(rejectedText(para)).toBe("Login with password")
  })

  it("chèn vào giữa một w:ins cũ ⇒ tách w:ins cũ, id mới không trùng", async () => {
    const { doc, blocks, who } = await setup(
      `<w:p><w:r><w:t xml:space="preserve">A </w:t></w:r><w:ins w:id="5" w:author="CR-001" w:date="2026-01-01T00:00:00Z"><w:r><w:t>B C</w:t></w:r></w:ins></w:p>`
    )
    applyEdit(blocks[0].element, "A B C", "A B X C", { ...who, author: "CR-002" })
    expect(paragraphText(blocks[0].element)).toBe("A B X C")
    const ids = wAll(doc, "ins").map((i) => wAttr(i, "id"))
    expect(new Set(ids).size).toBe(ids.length)
    for (const ins of wAll(doc, "ins")) expect(wAll(ins, "ins")).toHaveLength(0)
  })

  it("old text không khớp ⇒ OLD_TEXT_MISMATCH, không ghi gì; khoảng trắng khác vẫn nhận", async () => {
    const { doc, blocks, who } = await setup(p("Some  text"))
    const before = serializeXml(doc)
    expect(() => applyEdit(blocks[0].element, "Other text", "x", who)).toThrow(expect.objectContaining({ code: "OLD_TEXT_MISMATCH" }))
    expect(serializeXml(doc)).toBe(before)
    applyEdit(blocks[0].element, "Some text", "Some new text", who)
    expect(paragraphText(blocks[0].element)).toBe("Some  new text")
  })

  it("text chèn có tab/xuống dòng ⇒ w:tab / w:br", async () => {
    const { blocks, who } = await setup(p("A"))
    applyEdit(blocks[0].element, "A", "A\tB\nC", who)
    expect(paragraphText(blocks[0].element)).toBe("A\tB\nC")
    expect(wAll(blocks[0].element, "tab")).toHaveLength(1)
    expect(wAll(blocks[0].element, "br")).toHaveLength(1)
  })

  it("accept-all sau applyEdit cho đúng text mới, không còn revision", async () => {
    const { pkg, blocks, who } = await setup(p("The quick brown fox") + table([["cell one"]]))
    applyEdit(blocks[0].element, "The quick brown fox", "The slow brown dog", who)
    applyEdit(blocks[2].element, "cell one", "cell two", who)
    const res = await acceptAll(pkg)
    expect(res.revisions).toBeGreaterThan(0)
    const reread = await readBlocks(await DocxPackage.load(await pkg.toBuffer()))
    expect(reread.map((b) => b.text)).toEqual(["The slow brown dog", "cell two", "cell two"])
    const doc = await (await DocxPackage.load(await pkg.toBuffer())).requireXml("word/document.xml")
    expect(wAll(doc, "ins").length + wAll(doc, "del").length + wAll(doc, "delText").length).toBe(0)
  })
})
