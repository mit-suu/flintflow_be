import { describe, expect, it } from "vitest"
import { Document, Footer, Header, ImageRun, Packer, Paragraph } from "docx"
import { isPdfWithoutText, parseFileContent, PDF_MIN_CHARS_PER_PAGE } from "./file-text.js"

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")

const image = () => new ImageRun({ type: "png", data: PNG_1X1, transformation: { width: 20, height: 20 } })

const docx = (opts: { bodyImage?: boolean; headerImage?: boolean } = {}) =>
  Packer.toBuffer(
    new Document({
      sections: [
        {
          ...(opts.headerImage ? { headers: { default: new Header({ children: [new Paragraph({ children: [image()] })] }) } } : {}),
          footers: { default: new Footer({ children: [new Paragraph("Trang")] }) },
          children: [
            new Paragraph("Biên bản họp ngày 12/11 với khách hàng."),
            ...(opts.bodyImage ? [new Paragraph({ children: [image()] })] : []),
            new Paragraph("Khách cần duyệt đơn trong 1 ngày.")
          ]
        }
      ]
    })
  )

/** PDF tối thiểu, mỗi phần tử của `pages` là chữ của một trang ("" = trang không có lớp chữ, như bản scan). */
const pdf = (pages: string[]): Buffer => {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`]
  const fontId = 3 + pages.length * 2
  pages.forEach((txt, i) => {
    const stream = txt ? `BT /F1 12 Tf 72 720 Td (${txt}) Tj ET` : ""
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`)
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

describe("parseFileContent - cảnh báo khi trích chữ (FLF-449 việc 27)", () => {
  it("DOCX có ảnh trong thân ⇒ images_skipped, chữ vẫn đọc đủ", async () => {
    const res = await parseFileContent(await docx({ bodyImage: true }), DOCX, ".docx")
    expect(res.warnings).toEqual(["images_skipped"])
    expect(res.text).toContain("Biên bản họp ngày 12/11")
    expect(res.text).toContain("duyệt đơn trong 1 ngày")
  })

  it("DOCX chỉ có chữ, hoặc chỉ có logo ở header ⇒ không cảnh báo", async () => {
    expect((await parseFileContent(await docx(), DOCX, ".docx")).warnings).toEqual([])
    expect((await parseFileContent(await docx({ headerImage: true }), DOCX, ".docx")).warnings).toEqual([])
  })

  it("PDF có chữ ⇒ đọc được, không cảnh báo, buffer gốc không bị đổi", async () => {
    const buffer = pdf(["Customer needs order approval within one business day."])
    const before = Buffer.from(buffer)
    const res = await parseFileContent(buffer, "application/pdf", ".pdf")
    expect(res.text).toContain("Customer needs order approval within one business day.")
    expect(res.text).not.toMatch(/-- \d+ of \d+ --/)
    expect(res.warnings).toEqual([])
    expect(res.tokenCount).toBeGreaterThan(0)
    expect(buffer.equals(before)).toBe(true)
  })

  it("PDF scan (không có lớp chữ) ⇒ pdf_no_text", async () => {
    const res = await parseFileContent(pdf(["", ""]), "application/pdf", ".pdf")
    expect(res.text).toBe("")
    expect(res.warnings).toEqual(["pdf_no_text"])
  })

  it("PDF chỉ còn số trang / chữ chìm so với số trang ⇒ pdf_no_text", async () => {
    const res = await parseFileContent(pdf(["Scanned with CamScanner", "Scanned with CamScanner", "3"]), "application/pdf", ".pdf")
    expect(res.warnings).toEqual(["pdf_no_text"])
  })

  it("PDF hỏng ⇒ ném lỗi (nơi gọi lưu failed)", async () => {
    await expect(parseFileContent(Buffer.from("không phải pdf"), "application/pdf", ".pdf")).rejects.toThrow()
  })

  it(".doc Word 97-2003 (nhị phân) ⇒ báo lý do rõ: lưu lại thành .docx", async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Buffer.from("Word.Document")])
    await expect(parseFileContent(ole, "application/msword", ".doc")).rejects.toThrow(/\.doc \(Word 97-2003\).*\.docx/)
  })

  it(".doc thực chất là .docx (đổi đuôi) ⇒ vẫn đọc được", async () => {
    const res = await parseFileContent(await docx(), "application/msword", ".doc")
    expect(res.text).toContain("Biên bản họp")
  })

  it(".docx hỏng ⇒ báo file không phải .docx hợp lệ", async () => {
    await expect(parseFileContent(Buffer.from("plain text"), DOCX, ".docx")).rejects.toThrow(/không phải \.docx hợp lệ/)
  })

  it("TXT / MD ⇒ không cảnh báo", async () => {
    expect(await parseFileContent(Buffer.from("  ghi chú  "), "text/plain", ".txt")).toEqual({ text: "ghi chú", tokenCount: 2, warnings: [] })
  })
})

describe("isPdfWithoutText", () => {
  it("so theo số trang, chỉ đếm chữ cái và chữ số", () => {
    expect(isPdfWithoutText("", 1)).toBe(true)
    expect(isPdfWithoutText("- 1 -\n\n- 2 -", 2)).toBe(true)
    expect(isPdfWithoutText("a".repeat(PDF_MIN_CHARS_PER_PAGE), 1)).toBe(false)
    expect(isPdfWithoutText("a".repeat(PDF_MIN_CHARS_PER_PAGE), 2)).toBe(true)
    expect(isPdfWithoutText("Tiếng Việt có dấu đọc được bình thường", 1)).toBe(false)
    expect(isPdfWithoutText("x", 0)).toBe(true)
  })
})
