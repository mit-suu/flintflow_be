import { createRequire } from "module"

// pdf-parse và mammoth không có bundled TypeScript types nên dùng createRequire
// để import CommonJS module từ ESM context một cách an toàn.
const require = createRequire(import.meta.url)

/**
 * Ước lượng số token từ độ dài chuỗi.
 * Dùng tỷ lệ ~4 ký tự/token theo OpenAI estimation.
 * Không cần thư viện tokenizer chính xác ở giai đoạn này.
 */
export const estimateTokenCount = (text: string): number => {
  return Math.ceil(text.length / 4)
}

/** File đọc được ra chữ: PDF, DOCX/DOC, TXT/MD. */
export const isTextFile = (mimeType: string, extension: string): boolean => {
  const ext = extension.toLowerCase()
  return (
    ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "text/plain", "text/markdown"].includes(mimeType) ||
    [".pdf", ".docx", ".doc", ".txt", ".md"].includes(ext)
  )
}

/**
 * Parse nội dung text từ file đã upload (Buffer từ Multer memoryStorage).
 * Trả về { text, tokenCount } hoặc throw Error nếu parse thất bại.
 * Dùng chung: tài liệu project (mode 2/3) và tài liệu bổ sung của change request (mode 1).
 */
export const parseFileContent = async (
  buffer: Buffer,
  mimeType: string,
  extension: string
): Promise<{ text: string; tokenCount: number }> => {
  const ext = extension.toLowerCase()

  // PDF
  if (mimeType === "application/pdf" || ext === ".pdf") {
    const pdfParse = require("pdf-parse")
    const data = await pdfParse(buffer)
    const text = (data.text as string).trim()
    return { text, tokenCount: estimateTokenCount(text) }
  }

  // DOCX / DOC (mammoth chỉ hỗ trợ .docx tốt; .doc là legacy binary)
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword" ||
    ext === ".docx" ||
    ext === ".doc"
  ) {
    const mammoth = require("mammoth")
    const result = await mammoth.extractRawText({ buffer })
    const text = (result.value as string).trim()
    return { text, tokenCount: estimateTokenCount(text) }
  }

  // TXT / MD — đọc trực tiếp từ buffer
  if (
    mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    ext === ".txt" ||
    ext === ".md"
  ) {
    const text = buffer.toString("utf-8").trim()
    return { text, tokenCount: estimateTokenCount(text) }
  }

  throw new Error(`Unsupported file type for parsing: mimeType=${mimeType}, ext=${extension}`)
}
