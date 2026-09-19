import { describe, expect, it } from "vitest"
import { DocxPackage, readBlocks } from "../docx-ooxml/index.js"
import { makeDocx, p, styled, table } from "../docx-ooxml/testing/make-docx.js"
import { assignBlockIds, formatBlockId, parseDocument } from "./parse.service.js"
import { makeSrsDocx } from "./testing/srs-fixture.js"

describe("parseDocument", () => {
  it("gán block_id tuần tự, ghi bookmark cho đoạn, quét mention", async () => {
    const { pkg, blocks } = await parseDocument(await makeSrsDocx())
    expect(blocks[0]).toMatchObject({ block_id: "B0001", kind: "heading", bookmark: "_ff_B0001" })
    expect(blocks.map((b) => b.block_id)).toEqual(blocks.map((_, i) => formatBlockId(i + 1)))
    const table = blocks.find((b) => b.kind === "table")!
    expect(table.bookmark).toBe(`_fft_${table.block_id}`)
    expect(blocks.find((b) => b.text.includes("(UC-01)"))!.mentions).toEqual([{ entity: "use_case", id: "UC-01" }])
    // Bản lưu đọc lại ra đúng id theo bookmark
    const reread = await readBlocks(await DocxPackage.load(await pkg.toBuffer()))
    expect(reread.filter((b) => b.bookmark).length).toBe(blocks.filter((b) => b.bookmark).length)
  })

  it("parse lại cùng file ⇒ cùng block_id và text", async () => {
    const buf = await makeSrsDocx()
    const a = await parseDocument(buf)
    const b = await parseDocument(buf)
    expect(b.blocks.map((x) => [x.block_id, x.text])).toEqual(a.blocks.map((x) => [x.block_id, x.text]))
  })

  it("file đã có bookmark FlintFlow ⇒ giữ id cũ, block mới nhận id tiếp theo", async () => {
    const body =
      `<w:p><w:bookmarkStart w:id="0" w:name="_ff_B0005"/><w:bookmarkEnd w:id="0"/><w:r><w:t>Cũ</w:t></w:r></w:p>` +
      p("Mới chèn") +
      table([["X"]])
    const pkg = await DocxPackage.load(await makeDocx({ body }))
    const blocks = assignBlockIds(await readBlocks(pkg))
    expect(blocks.map((b) => [b.block_id, b.bookmark])).toEqual([
      ["B0005", "_ff_B0005"],
      ["B0006", "_ff_B0006"],
      ["B0007", "_fft_B0007"],
      ["B0008", "_ff_B0008"]
    ])
  })

  it("số block theo loại: heading, đoạn, list, bảng + từng ô; đoạn rỗng bị bỏ", async () => {
    const body = styled("u1", "1 Intro") + p("Para one") + styled("Dsach", "Item") + table([["A", "B"], ["c", "d"]]) + p("")
    const { blocks } = await parseDocument(await makeDocx({ body }))
    expect(blocks.map((b) => [b.block_id, b.kind, b.text])).toEqual([
      ["B0001", "heading", "1 Intro"],
      ["B0002", "paragraph", "Para one"],
      ["B0003", "list_item", "Item"],
      ["B0004", "table", "A | B\nc | d"],
      ["B0005", "table_cell", "A"],
      ["B0006", "table_cell", "B"],
      ["B0007", "table_cell", "c"],
      ["B0008", "table_cell", "d"]
    ])
    // SRS mẫu: 18 heading, 7 đoạn, 1 list, 3 bảng (6 + 9 + 4 ô)
    const srs = await parseDocument(await makeSrsDocx())
    const count = (kind: string) => srs.blocks.filter((b) => b.kind === kind).length
    expect(srs.blocks).toHaveLength(48)
    expect([count("heading"), count("paragraph"), count("list_item"), count("table"), count("table_cell")]).toEqual([18, 7, 1, 3, 19])
  })

  it("parse lại bản đã lưu (có bookmark neo) ⇒ block có neo giữ block_id, không thêm bookmark mới", async () => {
    const first = await parseDocument(await makeSrsDocx())
    const saved = await first.pkg.toBuffer()
    const second = await parseDocument(saved)
    const anchored = (blocks: typeof first.blocks) => blocks.filter((b) => b.bookmark).map((b) => [b.block_id, b.text])
    expect(anchored(second.blocks)).toEqual(anchored(first.blocks))
    const count = async (buf: Buffer) => (await (await DocxPackage.load(buf)).requireXml("word/document.xml")).getElementsByTagName("w:bookmarkStart").length
    expect(await count(await second.pkg.toBuffer())).toBe(await count(saved))
  })

  // LỖI SẢN PHẨM (báo cáo P4): block `table` không có bookmark nên khi parse lại bản đã lưu (version 0.0 → 0.1 ở
  // C-7 `write.service.ts:96`) nhận id mới sau id lớn nhất (B0049…) thay vì giữ B0005. Hệ quả: DocBlock bảng của
  // version mới mất `section_id` (tra `oldOf` theo block_id trượt) và FieldAnchor của thực thể trích từ bảng
  // (actors/UC/BR — `source_block_ids = [table.block_id]`) trỏ vào id không còn ở version mới.
  it("parse lại bản đã lưu ⇒ block bảng cũng giữ block_id (neo _fft_, FLF-178)", async () => {
    const first = await parseDocument(await makeSrsDocx())
    const second = await parseDocument(await first.pkg.toBuffer())
    expect(second.blocks.map((b) => [b.block_id, b.text])).toEqual(first.blocks.map((b) => [b.block_id, b.text]))
  })
})
