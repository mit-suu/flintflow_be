import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from "docx"
import { describe, expect, it } from "vitest"
import { blockIdOfBookmark, bookmarkName, ensureBlockBookmarks, findBlock, readBlocks } from "./blocks.js"
import { DocxPackage } from "./package.js"
import { imageRel, makeDocx, p, picture, styled, table } from "./testing/make-docx.js"
import { normalizeText, textHash } from "./text.js"
import { wAll, wAttr } from "./xml.js"

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
  it("ghi bookmark ẩn cho đoạn, bảng neo _fft_ trong ô đầu; đọc lại ra đúng block id; parse lại ổn định", async () => {
    const pkg = await load(styled("u1", "Giới thiệu") + p("Nội dung") + table([["X"]]))
    const blocks = await readBlocks(pkg)
    let n = 0
    const added = ensureBlockBookmarks(blocks, () => `B${String(++n).padStart(4, "0")}`)
    expect(added).toBe(4)
    expect(blocks.map((b) => b.bookmark)).toEqual(["_ff_B0001", "_ff_B0002", "_fft_B0003", "_ff_B0004"])

    const again = await readBlocks(await DocxPackage.load(await pkg.toBuffer()))
    expect(again.map((b) => blockIdOfBookmark(b.bookmark))).toEqual(["B0001", "B0002", "B0003", "B0004"])
    expect(again.map((b) => b.text)).toEqual(blocks.map((b) => b.text))
    expect(ensureBlockBookmarks(again, () => "B9999")).toBe(0)
  })

  it("neo bảng _fft_ (FLF-178): nằm ngay trước bảng vẫn nhận; không lẫn với neo _ff_ của ô đầu; bảng lồng không được neo", async () => {
    const bm = (id: number, name: string) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/><w:bookmarkEnd w:id="${id}"/>`
    const inner = `<w:tbl><w:tr><w:tc>${p("Lồng")}</w:tc></w:tr></w:tbl>`
    const blocks = await readBlocks(
      await load(bm(0, "_fft_B0003") + `<w:tbl><w:tr><w:tc><w:p>${bm(1, "_ff_B0004")}<w:r><w:t>Ô đầu</w:t></w:r></w:p>${inner}</w:tc></w:tr></w:tbl>`)
    )
    expect(blocks.map((b) => [b.kind, b.bookmark])).toEqual([
      ["table", "_fft_B0003"],
      ["table_cell", "_ff_B0004"],
      ["unsupported", null]
    ])
    expect(ensureBlockBookmarks(blocks, () => "B9999")).toBe(0)
    expect(blockIdOfBookmark("_fft_B0003")).toBe("B0003")
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

describe("readBlocks — bổ sung P4", () => {
  it("heading theo chuỗi basedOn (style riêng dựa trên heading 2), style vòng không treo; đoạn số mục kết thúc dấu câu không phải heading", async () => {
    const styles =
      `<w:style w:type="paragraph" w:styleId="u2"><w:name w:val="heading 2"/></w:style>` +
      `<w:style w:type="paragraph" w:styleId="CongTyH2"><w:name w:val="Cong ty H2"/><w:basedOn w:val="u2"/></w:style>` +
      `<w:style w:type="paragraph" w:styleId="VongA"><w:name w:val="Vong A"/><w:basedOn w:val="VongB"/></w:style>` +
      `<w:style w:type="paragraph" w:styleId="VongB"><w:name w:val="Vong B"/><w:basedOn w:val="VongA"/></w:style>`
    const pkg = await DocxPackage.load(
      await makeDocx({
        styles,
        body: styled("CongTyH2", "Mục con") + styled("VongA", "Đoạn style vòng") + p("3.1 Người dùng đăng nhập vào hệ thống.") + p("3.1 1 lần")
      })
    )
    const blocks = await readBlocks(pkg)
    expect(blocks.map((b) => [b.kind, b.level, b.heading_detector, b.style_name])).toEqual([
      ["heading", 2, "style", "Cong ty H2"],
      ["paragraph", null, null, "Vong A"],
      ["paragraph", null, null, null],
      ["paragraph", null, null, null]
    ])
  })

  it("heading trong ô bảng không tính là heading; heading_path cắt đúng khi lên cấp", async () => {
    const blocks = await readBlocks(
      await load(
        styled("u1", "Chương 1") +
          styled("u2", "Mục 1.1") +
          `<w:tbl><w:tr><w:tc>${styled("u1", "Trong ô")}</w:tc></w:tr></w:tbl>` +
          styled("u2", "Mục 1.2") +
          p("Nội dung 1.2")
      )
    )
    expect(blocks.find((b) => b.text === "Trong ô" && b.kind !== "table")).toMatchObject({ kind: "table_cell", level: null })
    const body = blocks.find((b) => b.text === "Nội dung 1.2")!
    expect(body.heading_path).toEqual(["Chương 1", "Mục 1.2"])
  })

  it("list có numbering: numPr trực tiếp nhiều cấp, giữ thứ tự, không nhầm với heading", async () => {
    const num = (ilvl: number) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="7"/></w:numPr>`
    const blocks = await readBlocks(await load(p("Bước một", num(0)) + p("Bước con", num(1)) + p("Bước hai", num(0)) + p("Đoạn thường")))
    expect(blocks.map((b) => [b.kind, b.text, b.level])).toEqual([
      ["list_item", "Bước một", null],
      ["list_item", "Bước con", null],
      ["list_item", "Bước hai", null],
      ["paragraph", "Đoạn thường", null]
    ])
    expect(blocks.every((b) => b.editable)).toBe(true)
  })

  it("ô gộp: gridSpan giữ một ô, vMerge tiếp nối (ô rỗng) không sinh block; cột tính theo thứ tự w:tc", async () => {
    const tc = (content: string, tcPr = "") => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${content}</w:tc>`
    const blocks = await readBlocks(
      await load(
        `<w:tbl><w:tblPr/><w:tblGrid/>` +
          `<w:tr>${tc(p("Tiêu đề gộp"), `<w:gridSpan w:val="2"/>`)}</w:tr>` +
          `<w:tr>${tc(p("A"), `<w:vMerge w:val="restart"/>`)}${tc(p("B"))}</w:tr>` +
          `<w:tr>${tc("<w:p/>", "<w:vMerge/>")}${tc(p("C"))}</w:tr>` +
          `</w:tbl>`
      )
    )
    expect(blocks[0]).toMatchObject({ kind: "table", rows: [["Tiêu đề gộp"], ["A", "B"], ["", "C"]] })
    expect(blocks.slice(1).map((b) => [b.text, b.cell])).toEqual([
      ["Tiêu đề gộp", { table: 0, row: 0, col: 0 }],
      ["A", { table: 0, row: 1, col: 0 }],
      ["B", { table: 0, row: 1, col: 1 }],
      ["C", { table: 0, row: 2, col: 1 }]
    ])
  })

  it("bảng lồng: bảng cấp 1 kế tiếp vẫn đánh số 1 (bảng lồng không tăng bộ đếm)", async () => {
    const nested = `<w:tbl><w:tr><w:tc>${p("Lồng")}</w:tc></w:tr></w:tbl>`
    const blocks = await readBlocks(await load(`<w:tbl><w:tr><w:tc>${p("T0")}${nested}</w:tc></w:tr></w:tbl>` + table([["T1"]])))
    expect(blocks.filter((b) => b.kind === "unsupported").map((b) => [b.text, b.rows, b.editable])).toEqual([["Lồng", [["Lồng"]], false]])
    expect(blocks.find((b) => b.text === "T1" && b.kind === "table_cell")?.cell).toEqual({ table: 1, row: 0, col: 0 })
  })

  it("ảnh + caption: ảnh ⇒ image (không sửa), caption sau ảnh ⇒ caption sửa được, cùng heading_path; textbox rỗng chữ ⇒ unsupported", async () => {
    const blocks = await readBlocks(
      await load(
        styled("u1", "Kiến trúc") +
          `<w:p><w:r><w:drawing/></w:r></w:p>` +
          styled("Chuthich", "Hình 1: Kiến trúc tổng thể") +
          `<w:p><w:r><w:pict><w:txbxContent><w:p/></w:txbxContent></w:pict></w:r></w:p>`
      )
    )
    expect(blocks.map((b) => [b.kind, b.text, b.editable, b.style_name])).toEqual([
      ["heading", "Kiến trúc", true, "heading 1"],
      ["image", "", false, null],
      ["caption", "Hình 1: Kiến trúc tổng thể", true, "caption"],
      ["unsupported", "", false, null]
    ])
    expect(blocks[1].heading_path).toEqual(["Kiến trúc"])
    expect(blocks[2].heading_path).toEqual(["Kiến trúc"])
    expect(blocks[1].xml_path).toBe("body/p[1]")
  })

  it("phase 5 (T3): ảnh nhúng ⇒ image_ref = part ảnh theo rels; rel không phải ảnh / liên kết ngoài / không phải hình ⇒ null", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: picture("rIdImg1") + picture("rIdMissing") + p("Chữ"),
        extraDocRels: imageRel("rIdImg1", "image1.png"),
        extraParts: { "word/media/image1.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
      })
    )
    const blocks = await readBlocks(pkg)
    expect(blocks.map((b) => [b.kind, b.image_ref])).toEqual([
      ["image", "word/media/image1.png"],
      ["image", null],
      ["paragraph", null]
    ])
    expect(await pkg.binary("word/media/image1.png")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await pkg.binary("word/media/none.png")).toBeNull()
  })

  it("ảnh nhận bookmark neo nằm ngoài w:p ngay trước nó", async () => {
    const blocks = await readBlocks(
      await load(`<w:bookmarkStart w:id="0" w:name="_ff_B0003"/><w:bookmarkEnd w:id="0"/><w:p><w:r><w:drawing/></w:r></w:p>` + p("Sau ảnh"))
    )
    expect(blocks.map((b) => [b.kind, b.bookmark])).toEqual([
      ["image", "_ff_B0003"],
      ["paragraph", null]
    ])
  })

  it("paraId lấy cho đoạn và ô bảng; bảng không có paraId; paraId trùng ⇒ findBlock không đoán", async () => {
    const blocks = await readBlocks(
      await load(
        `<w:p w14:paraId="00000001"><w:r><w:t>Đoạn</w:t></w:r></w:p>` +
          `<w:tbl><w:tr><w:tc><w:p w14:paraId="00000002"><w:r><w:t>Ô</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
          `<w:p w14:paraId="00000003"><w:r><w:t>X</w:t></w:r></w:p><w:p w14:paraId="00000003"><w:r><w:t>Y</w:t></w:r></w:p>`
      )
    )
    expect(blocks.map((b) => [b.kind, b.para_id])).toEqual([
      ["paragraph", "00000001"],
      ["table", null],
      ["table_cell", "00000002"],
      ["paragraph", "00000003"],
      ["paragraph", "00000003"]
    ])
    expect(findBlock(blocks, { para_id: "00000002" })?.text).toBe("Ô")
    expect(findBlock(blocks, { para_id: "00000003" })).toBeNull()
  })

  it("text chuẩn hoá: hyperlink/smartTag được đọc, moveFrom bị bỏ, noBreakHyphen/cr; hash không phụ thuộc khoảng trắng", async () => {
    const [b] = await readBlocks(
      await load(
        `<w:p><w:hyperlink r:id="rId9"><w:r><w:t>Link</w:t></w:r></w:hyperlink><w:smartTag><w:r><w:t xml:space="preserve"> tag</w:t></w:r></w:smartTag>` +
          `<w:moveFrom w:id="1" w:author="CR-001"><w:r><w:t>cũ</w:t></w:r></w:moveFrom>` +
          `<w:r><w:t xml:space="preserve"> e</w:t><w:noBreakHyphen/><w:t>mail</w:t><w:cr/><w:t>x</w:t></w:r></w:p>`
      )
    )
    expect(b.text).toBe("Link tag e-mail\nx")
    expect(normalizeText("  Link \t tag  e-mail\nx ")).toBe("Link tag e-mail x")
    expect(b.text_hash).toBe(textHash("Link tag e-mail x"))
    expect(textHash("a  b")).toBe(textHash(" a b "))
    expect(textHash("a b")).not.toBe(textHash("ab"))
  })

  it("ensureBlockBookmarks: assign trả null ⇒ bỏ qua; id bookmark nối tiếp id có sẵn; chèn sau pPr", async () => {
    const pkg = await load(
      `<w:p><w:bookmarkStart w:id="41" w:name="_GoBack"/><w:bookmarkEnd w:id="41"/><w:r><w:t>Có sẵn</w:t></w:r></w:p>` + p("Có pPr", `<w:jc w:val="center"/>`) + p("Bỏ")
    )
    const blocks = await readBlocks(pkg)
    expect(ensureBlockBookmarks(blocks, (b) => (b.text === "Bỏ" ? null : `B${b.ordinal}`))).toBe(2)
    expect(blocks.map((b) => b.bookmark)).toEqual(["_ff_B0", "_ff_B1", null])
    const doc = await pkg.requireXml("word/document.xml")
    const ours = wAll(doc, "bookmarkStart").filter((x) => wAttr(x, "name")?.startsWith("_ff_"))
    expect(ours.map((x) => wAttr(x, "id"))).toEqual(["42", "43"])
    expect(Array.from(blocks[1].element.childNodes).map((n) => (n as Element).localName)).toEqual(["pPr", "bookmarkStart", "bookmarkEnd", "r"])
  })

  it("không có w:body ⇒ không block; blockIdOfBookmark với tên lạ ⇒ null", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("x") }))
    const doc = await pkg.requireXml("word/document.xml")
    const body = wAll(doc, "body")[0]
    body.parentNode!.removeChild(body)
    expect(await readBlocks(pkg)).toEqual([])
    expect(blockIdOfBookmark("_GoBack")).toBeNull()
    expect(blockIdOfBookmark(null)).toBeNull()
  })
})
