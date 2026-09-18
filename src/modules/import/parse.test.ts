import { describe, expect, it } from "vitest"
import { DocxPackage, readBlocks } from "../docx-ooxml/index.js"
import { makeDocx, p, table } from "../docx-ooxml/testing/make-docx.js"
import { scanCodeMentions, scanMentions, scanNameMentions } from "./mentions.js"
import { assignBlockIds, formatBlockId, parseDocument } from "./parse.service.js"
import { makeSrsDocx } from "./testing/srs-fixture.js"

describe("mentions", () => {
  it("bắt mã UC/FR/NFR/BR/SCR, chuẩn hoá, không bắt nhầm trong từ khác", () => {
    expect(scanCodeMentions("See UC-01, UC02 and uc-3; FR-2.1, NFR_04, BR 12, SCR-05.")).toEqual([
      { entity: "use_case", id: "UC-01" },
      { entity: "use_case", id: "UC-02" },
      { entity: "function", id: "FR-2.1" },
      { entity: "nfr", id: "NFR-04" },
      { entity: "business_rule", id: "BR-12" },
      { entity: "screen", id: "SCR-05" }
    ])
    expect(scanCodeMentions("ABUC-01 và UC-01X và BRAND-1")).toEqual([])
  })

  it("bắt theo tên sau I-4 (không phân biệt hoa thường, bỏ tên quá ngắn)", () => {
    const names = [
      { entity: "actor" as const, id: "A01", name: "Learner" },
      { entity: "entity" as const, id: "E01", name: "Course" },
      { entity: "actor" as const, id: "A02", name: "PM" }
    ]
    expect(scanNameMentions("The learner opens a course list. PM approves.", names)).toEqual([
      { entity: "actor", id: "A01" },
      { entity: "entity", id: "E01" }
    ])
    expect(scanNameMentions("Learners and Coursework", names)).toEqual([])
    expect(scanMentions("UC-01 by Learner", names)).toEqual([
      { entity: "use_case", id: "UC-01" },
      { entity: "actor", id: "A01" }
    ])
  })
})

describe("parseDocument", () => {
  it("gán block_id tuần tự, ghi bookmark cho đoạn, quét mention", async () => {
    const { pkg, blocks } = await parseDocument(await makeSrsDocx())
    expect(blocks[0]).toMatchObject({ block_id: "B0001", kind: "heading", bookmark: "_ff_B0001" })
    expect(blocks.map((b) => b.block_id)).toEqual(blocks.map((_, i) => formatBlockId(i + 1)))
    const table = blocks.find((b) => b.kind === "table")!
    expect(table.bookmark).toBeNull()
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
      ["B0007", null],
      ["B0008", "_ff_B0008"]
    ])
  })
})
