import { createRequire } from "module"
import { estimateTokenCount, isPdfWithoutText, type FileTextWarning, type ParsedFileContent } from "./parsed-file-content.js"

// pdf-parse không có bundled TypeScript types nên dùng createRequire để import CommonJS module từ ESM context.
const require = createRequire(import.meta.url)

/**
 * FLF-458: tách riêng khỏi `file-text.ts` — bộ đọc PDF không dùng chung được với I-4 (bộ đọc .docx của I-4 là
 * `docx-ooxml`, không đọc PDF); giữ `pdf-parse` ở đây để `file-text.ts` không còn trực tiếp import thư viện này.
 */
export const readPdf = async (buffer: Buffer): Promise<ParsedFileContent> => {
  const { PDFParse } = require("pdf-parse")
  // pdf-parse v2: lớp `PDFParse`. Đưa bản sao vì pdf.js có thể chuyển (detach) bộ đệm - buffer gốc còn dùng để băm / tải lên kho.
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    // Không chèn dấu "-- 1 of 3 --" giữa các trang vào chữ đã trích
    const result = await parser.getText({ pageJoiner: "" })
    const text = String(result.text ?? "").trim()
    const warnings: FileTextWarning[] = isPdfWithoutText(text, Number(result.total) || 1) ? ["pdf_no_text"] : []
    return { text, tokenCount: estimateTokenCount(text), warnings }
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}
