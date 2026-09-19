import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { DocxPackage, writeStamp } from "../docx-ooxml/index.js"
import { makeDocx, p, table } from "../docx-ooxml/testing/make-docx.js"
import { MAX_UNCOMPRESSED_BYTES } from "../docx-ooxml/index.js"
import { preflightDocx } from "./preflight.service.js"

const ole = (...streams: string[]): Buffer =>
  Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(100), ...streams.map((s) => Buffer.from(s, "utf16le"))])

const trackedBody = (author: string) =>
  p("Đoạn đầu") +
  `<w:p><w:r><w:t xml:space="preserve">Sửa </w:t></w:r><w:ins w:id="1" w:author="${author}"><w:r><w:t>mới</w:t></w:r></w:ins><w:del w:id="2" w:author="${author}"><w:r><w:delText>cũ</w:delText></w:r></w:del></w:p>`

const withComment = async (author: string): Promise<Buffer> =>
  makeDocx({
    body: `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Có comment</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`,
    extraParts: {
      "word/comments.xml": `<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="${author}"><w:p><w:r><w:t>hỏi</w:t></w:r></w:p></w:comment></w:comments>`
    }
  })

describe("preflightDocx", () => {
  it("nhận loại file theo magic bytes", async () => {
    expect((await preflightDocx(Buffer.from("hello world"))).issues[0].code).toBe("NOT_DOCX")
    expect((await preflightDocx(ole("WordDocument"))).issues[0].code).toBe("LEGACY_DOC")
    expect((await preflightDocx(ole("EncryptionInfo", "EncryptedPackage"))).issues[0].code).toBe("FILE_ENCRYPTED")
    expect((await preflightDocx(ole("Workbook"))).issues[0].code).toBe("NOT_DOCX")
    const zip = new JSZip()
    zip.file("a.txt", "x")
    expect((await preflightDocx(await zip.generateAsync({ type: "nodebuffer" }))).issues[0].code).toBe("NOT_DOCX")
    const broken = Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.alloc(50)])
    expect((await preflightDocx(broken)).issues[0].code).toBe("CORRUPT_ZIP")
  })

  it("quá dung lượng, tài liệu rỗng", async () => {
    expect((await preflightDocx(await makeDocx({ body: p("x") }), { maxBytes: 10 })).issues[0].code).toBe("FILE_TOO_LARGE")
    expect((await preflightDocx(await makeDocx({ body: p("") }))).issues[0].code).toBe("EMPTY_DOCUMENT")
  })

  it("Track Changes của tác giả lạ ⇒ từ chối kèm vị trí, gộp cặp del+ins cùng đoạn", async () => {
    const res = await preflightDocx(await makeDocx({ body: trackedBody("Nguyen Van A") }))
    expect(res.status).toBe("rejected")
    expect(res.issues).toEqual([
      { code: "FOREIGN_TRACK_CHANGE", message: 'Track Changes (sửa chữ) của "Nguyen Van A" chưa được Accept/Reject', location: { block_ord: 1, text: "Sửa mới" } }
    ])
  })

  it("Track Changes/comment author mã CR ⇒ nhận", async () => {
    const res = await preflightDocx(await makeDocx({ body: trackedBody("CR-003") }))
    expect(res).toEqual({ status: "accepted", issues: [], stamp: null })
    expect((await preflightDocx(await withComment("CR-001"))).status).toBe("accepted")
  })

  it("comment của người khác ⇒ FOREIGN_COMMENT có vị trí", async () => {
    const res = await preflightDocx(await withComment("Lan"))
    expect(res.issues).toEqual([{ code: "FOREIGN_COMMENT", message: 'Comment của "Lan" chưa được xử lý', location: { block_ord: 0, text: "Có comment" } }])
  })

  it("đọc stamp", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("x") }))
    await writeStamp(pkg, { project_id: "p1", version: "0.2", source: "cr_revision" })
    expect((await preflightDocx(await pkg.toBuffer())).stamp).toEqual({ project_id: "p1", version: "0.2", source: "cr_revision" })
  })

  it("zip bomb (kích thước giải nén khai báo vượt trần) ⇒ FILE_TOO_LARGE, không giải nén", async () => {
    const buf = Buffer.from(await makeDocx({ body: p("x") }))
    // Sửa trường uncompressed size (offset 24) của mọi mục central directory (chữ ký 0x02014b50)
    let n = 0
    for (let i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); i >= 0; i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i + 4)) {
      buf.writeUInt32LE(Math.floor(MAX_UNCOMPRESSED_BYTES / 2), i + 24)
      n++
    }
    expect(n).toBeGreaterThan(2)
    const res = await preflightDocx(buf)
    expect(res).toMatchObject({ status: "rejected", issues: [{ code: "FILE_TOO_LARGE", location: null }] })
  })

  it("mọi lỗi định dạng file đều trả status rejected, một issue không có vị trí", async () => {
    for (const buf of [Buffer.from("x"), ole("WordDocument"), ole("EncryptedPackage")]) {
      const res = await preflightDocx(buf)
      expect(res.status).toBe("rejected")
      expect(res.issues).toHaveLength(1)
      expect(res.issues[0].location).toBeNull()
      expect(res.stamp).toBeNull()
    }
  })

  it("Track Changes trong ô bảng ⇒ vị trí là ô đó; đổi định dạng ghi nhãn riêng; tác giả trống ⇒ 'không rõ'", async () => {
    const cell = `<w:tbl><w:tblPr/><w:tblGrid/><w:tr><w:tc><w:p><w:ins w:id="3" w:author="Minh"><w:r><w:t>Ô sửa</w:t></w:r></w:ins></w:p></w:tc></w:tr></w:tbl>`
    const fmt = `<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="4" w:author=""><w:rPr/></w:rPrChange></w:rPr><w:t>In đậm</w:t></w:r></w:p>`
    const res = await preflightDocx(await makeDocx({ body: p("Đầu") + cell + fmt }))
    expect(res.status).toBe("rejected")
    expect(res.issues).toEqual([
      { code: "FOREIGN_TRACK_CHANGE", message: 'Track Changes (sửa chữ) của "Minh" chưa được Accept/Reject', location: { block_ord: 2, text: "Ô sửa" } },
      { code: "FOREIGN_TRACK_CHANGE", message: 'Track Changes (đổi định dạng) của "không rõ" chưa được Accept/Reject', location: { block_ord: 3, text: "In đậm" } }
    ])
  })

  it("trộn revision CR-xxx với revision tác giả lạ ⇒ chỉ báo tác giả lạ; 'CR-1' (ít hơn 3 số) không phải mã CR", async () => {
    const body =
      `<w:p><w:ins w:id="1" w:author="CR-003"><w:r><w:t>ok</w:t></w:r></w:ins></w:p>` + `<w:p><w:ins w:id="2" w:author="CR-1"><w:r><w:t>lạ</w:t></w:r></w:ins></w:p>`
    const res = await preflightDocx(await makeDocx({ body }))
    expect(res.issues.map((i) => [i.code, i.location?.text])).toEqual([["FOREIGN_TRACK_CHANGE", "lạ"]])
  })

  it("không có stamp ⇒ stamp null; bảng không ảnh hưởng việc nhận file", async () => {
    const res = await preflightDocx(await makeDocx({ body: p("A") + table([["x", "y"]]) }))
    expect(res).toEqual({ status: "accepted", issues: [], stamp: null })
  })
})
