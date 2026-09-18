import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from "docx"
import { describe, expect, it } from "vitest"
import { blockIdOfBookmark, bookmarkName, ensureBlockBookmarks, findBlock, readBlocks } from "./blocks.js"
import { DocxPackage } from "./package.js"
import { makeDocx, p, styled, table } from "./testing/make-docx.js"
import { textHash } from "./text.js"

const load = async (body: string) => DocxPackage.load(await makeDocx({ body }))

describe("readBlocks", () => {
  it("heading theo w:name khi styleId bị bản địa hoá, theo outlineLvl của style, bỏ mục lục", async () => {
    const pkg = await load(
      styled("Mucluc1", "1 Giới thiệu\t3") +
        styled("u1", "Giới thiệu") +
        p("Đoạn mở đầu.") +
        styled("u2", "Mục đích") +
        styled("MyH3", "Phạm vi chi tiết") +
        p("Nội dung.") +
        styled("u1", "Yêu cầu")
    )
    const blocks = await readBlocks(pkg)
    expect(blocks.map((b) => [b.kind, b.level, b.heading_detector, b.text])).toEqual([
      ["heading", 1, "style", "Giới thiệu"],
      ["paragraph", null, null, "Đoạn mở đầu."],
      ["heading", 2, "style", "Mục đích"],
      ["heading", 3, "outline_level", "Phạm vi chi tiết"],
      ["paragraph", null, null, "Nội dung."],
      ["heading", 1, "style", "Yêu cầu"]
    ])
    expect(blocks[4].heading_path).toEqual(["Giới thiệu", "Mục đích", "Phạm vi chi tiết"])
    expect(blocks[5].heading_path).toEqual([])
    expect(blocks.map((b) => b.ordinal)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("heading theo outlineLvl trực tiếp và theo mẫu số mục khi file không dùng style", async () => {
    const blocks = await readBlocks(
      await load(
        p("Chương mở", `<w:outlineLvl w:val="0"/>`) +
          p("3.2  Danh sách use case") +
          p("3.2.1\tRegister account") +
          p("1. Người dùng mở trang đăng ký.") +
          p("2024 là năm bắt đầu") +
          p("Body text", `<w:outlineLvl w:val="9"/>`)
      )
    )
    expect(blocks.map((b) => [b.kind, b.level, b.heading_detector])).toEqual([
      ["heading", 1, "outline_level"],
      ["heading", 2, "numbering_pattern"],
      ["heading", 3, "numbering_pattern"],
      ["paragraph", null, null],
      ["paragraph", null, null],
      ["paragraph", null, null]
    ])
    expect(blocks[2].heading_path).toEqual(["Chương mở", "3.2  Danh sách use case"])
  })

  it("list theo numPr trực tiếp hoặc theo style; caption; đoạn rỗng bị bỏ", async () => {
    const blocks = await readBlocks(
      await load(
        p("Mục một", `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>`) +
          styled("Dsach", "Mục hai") +
          p("") +
          styled("Chuthich", "Hình 1: Sơ đồ")
      )
    )
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["list_item", "Mục một"],
      ["list_item", "Mục hai"],
      ["caption", "Hình 1: Sơ đồ"]
    ])
  })

  it("bảng: block table + table_cell theo ô, bảng lồng ⇒ unsupported", async () => {
    const nested = `<w:tbl><w:tr><w:tc>${p("Ô lồng")}</w:tc></w:tr></w:tbl>`
    const blocks = await readBlocks(
      await load(
        table([
          ["Use Case ID", "Name"],
          ["UC-01", "Register"]
        ]) + `<w:tbl><w:tr><w:tc>${p("Ngoài")}${nested}</w:tc></w:tr></w:tbl>`
      )
    )
    expect(blocks[0]).toMatchObject({ kind: "table", editable: false, rows: [["Use Case ID", "Name"], ["UC-01", "Register"]] })
    expect(blocks[0].text).toBe("Use Case ID | Name\nUC-01 | Register")
    expect(blocks.slice(1, 5).map((b) => [b.kind, b.text, b.cell])).toEqual([
      ["table_cell", "Use Case ID", { table: 0, row: 0, col: 0 }],
      ["table_cell", "Name", { table: 0, row: 0, col: 1 }],
      ["table_cell", "UC-01", { table: 0, row: 1, col: 0 }],
      ["table_cell", "Register", { table: 0, row: 1, col: 1 }]
    ])
    expect(blocks[4].xml_path).toBe("body/tbl[0]/tr[1]/tc[1]/p[0]")
    expect(blocks.slice(5).map((b) => [b.kind, b.text, b.editable])).toEqual([
      // text ô chỉ lấy đoạn trực tiếp; bảng lồng thành block unsupported riêng
      ["table", "Ngoài", false],
      ["table_cell", "Ngoài", true],
      ["unsupported", "Ô lồng", false]
    ])
  })

  it("text bỏ phần w:del, lấy w:ins, tab/br; paraId; ảnh và field ⇒ không sửa được", async () => {
    const blocks = await readBlocks(
      await load(
        `<w:p w14:paraId="1A2B3C4D"><w:r><w:t>Hệ </w:t></w:r><w:del w:id="1" w:author="CR-001"><w:r><w:delText>cũ</w:delText></w:r></w:del>` +
          `<w:ins w:id="2" w:author="CR-001"><w:r><w:t>mới</w:t></w:r></w:ins><w:r><w:tab/><w:t>x</w:t><w:br/><w:t>y</w:t></w:r></w:p>` +
          `<w:p><w:r><w:drawing/></w:r></w:p>` +
          `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>REF _Ref1</w:instrText></w:r><w:r><w:t>Hình 2</w:t></w:r></w:p>` +
          `<w:p><w:r><w:t>Có textbox</w:t></w:r><w:r><w:pict><w:txbxContent>${p("trong hộp")}</w:txbxContent></w:pict></w:r></w:p>`
      )
    )
    expect(blocks.map((b) => [b.kind, b.text, b.editable, b.para_id])).toEqual([
      ["paragraph", "Hệ mới\tx\ny", true, "1A2B3C4D"],
      ["image", "", false, null],
      ["paragraph", "Hình 2", false, null],
      ["paragraph", "Có textbox", false, null]
    ])
    expect(blocks[0].text_hash).toBe(textHash("Hệ  mới x y"))
  })

  it("mục lục trong content control bị bỏ, content control thường được đi vào", async () => {
    const toc = `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>${p("Mục lục 1")}</w:sdtContent></w:sdt>`
    const cc = `<w:sdt><w:sdtPr/><w:sdtContent>${p("Trong control")}</w:sdtContent></w:sdt>`
    // thư viện docx: content control mục lục không có docPartGallery, chỉ có field TOC
    const tocField =
      `<w:sdt><w:sdtPr/><w:sdtContent><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC \\o "1-3"</w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>${p("1 Intro")}</w:sdtContent></w:sdt>`
    const blocks = await readBlocks(await load(toc + cc + tocField))
    expect(blocks.map((b) => [b.text, b.xml_path])).toEqual([["Trong control", "body/sdt[1]/sdtContent/p[0]"]])
  })

  it("đọc được file do thư viện docx sinh (không có paraId)", async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: "Introduction", heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ text: "Purpose text." }),
            new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("A")] })] })] })
          ]
        }
      ]
    })
    const blocks = await readBlocks(await DocxPackage.load(await Packer.toBuffer(doc)))
    expect(blocks.map((b) => [b.kind, b.text, b.para_id])).toEqual([
      ["heading", "Introduction", null],
      ["paragraph", "Purpose text.", null],
      ["table", "A", null],
      ["table_cell", "A", null]
    ])
  })
})

describe("neo bookmark", () => {
  it("ghi bookmark ẩn cho đoạn, bỏ bảng; đọc lại ra đúng block id; parse lại ổn định", async () => {
    const pkg = await load(styled("u1", "Giới thiệu") + p("Nội dung") + table([["X"]]))
    const blocks = await readBlocks(pkg)
    let n = 0
    const added = ensureBlockBookmarks(blocks, () => `B${String(++n).padStart(4, "0")}`)
    expect(added).toBe(3)
    expect(blocks.map((b) => b.bookmark)).toEqual(["_ff_B0001", "_ff_B0002", null, "_ff_B0003"])

    const again = await readBlocks(await DocxPackage.load(await pkg.toBuffer()))
    expect(again.map((b) => blockIdOfBookmark(b.bookmark))).toEqual(["B0001", "B0002", null, "B0003"])
    expect(again.map((b) => b.text)).toEqual(blocks.map((b) => b.text))
    expect(ensureBlockBookmarks(again, () => "B9999")).toBe(0)
  })

  it("bookmark bị Word dời ra ngoài w:p gắn cho đoạn kế tiếp; bookmark trùng tên chỉ nhận lần đầu", async () => {
    const bm = (id: number, name: string) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/><w:bookmarkEnd w:id="${id}"/>`
    const blocks = await readBlocks(
      await load(
        bm(0, bookmarkName("B0007")) +
          p("Sau bookmark") +
          `<w:tbl><w:tr><w:tc>${bm(1, "_ff_B0008")}${p("Trong ô")}</w:tc></w:tr></w:tbl>` +
          `<w:p>${bm(2, "_ff_B0007")}<w:r><w:t>Trùng</w:t></w:r></w:p>` +
          `<w:p>${bm(3, "_GoBack")}<w:r><w:t>Bookmark khác</w:t></w:r></w:p>`
      )
    )
    expect(blocks.map((b) => [b.text, b.bookmark])).toEqual([
      ["Sau bookmark", "_ff_B0007"],
      ["Trong ô", null],
      ["Trong ô", "_ff_B0008"],
      ["Trùng", null],
      ["Bookmark khác", null]
    ])
  })

  it("findBlock: bookmark → paraId → text_hash duy nhất; mơ hồ ⇒ null", async () => {
    const blocks = await readBlocks(
      await load(
        `<w:p w14:paraId="0000000A"><w:bookmarkStart w:id="0" w:name="_ff_B0001"/><w:bookmarkEnd w:id="0"/><w:r><w:t>Một</w:t></w:r></w:p>` +
          `<w:p w14:paraId="0000000B"><w:r><w:t>Hai</w:t></w:r></w:p>` +
          p("Ba") +
          p("Ba")
      )
    )
    expect(findBlock(blocks, { bookmark: "_ff_B0001" })?.text).toBe("Một")
    expect(findBlock(blocks, { bookmark: "_ff_B0404", para_id: "0000000B" })?.text).toBe("Hai")
    expect(findBlock(blocks, { text_hash: textHash("Hai") })?.text).toBe("Hai")
    expect(findBlock(blocks, { text_hash: textHash("Ba") })).toBeNull()
    expect(findBlock(blocks, {})).toBeNull()
  })
})
