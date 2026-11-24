/**
 * File mẫu nhỏ dựng bằng code cho test tải tài liệu (FLF-449 việc 27): PDF tối thiểu (có / không có lớp chữ) và .docx có ảnh.
 */
import { Document, ImageRun, Packer, Paragraph } from "docx"

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")

/** PDF tối thiểu, mỗi phần tử của `pages` là chữ của một trang ("" = trang không có lớp chữ, như bản scan). Chữ ASCII. */
export const minimalPdf = (pages: string[]): Buffer => {
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

/** .docx một đoạn chữ, `withImage` ⇒ thêm một ảnh PNG 1x1 trong thân. */
export const docxBuffer = (text: string, withImage = false): Promise<Buffer> =>
  Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph(text),
            ...(withImage ? [new Paragraph({ children: [new ImageRun({ type: "png", data: PNG_1X1, transformation: { width: 20, height: 20 } })] })] : [])
          ]
        }
      ]
    })
  )
