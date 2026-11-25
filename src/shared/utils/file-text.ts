import { createRequire } from "module"
import JSZip from "jszip"

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
 * FLF-449 việc 27: điều Code biết chắc là đã mất khi trích chữ (BF §3.6 "Định dạng"):
 * - `pdf_no_text`: PDF không có lớp chữ (bản scan) hoặc gần như không có chữ so với số trang.
 * - `images_skipped`: file .docx có hình / sơ đồ trong thân tài liệu, chỉ chữ được đọc.
 */
export type FileTextWarning = "pdf_no_text" | "images_skipped"

export interface ParsedFileContent {
  text: string
  tokenCount: number
  warnings: FileTextWarning[]
}

/**
 * Dưới mức này (chữ cái + chữ số, trung bình mỗi trang) coi như PDF không có lớp chữ. Trang PDF chữ thật có hàng trăm ký tự;
 * bản scan thường chỉ còn dấu trang / chữ chìm kiểu "Scanned with CamScanner" (~21 ký tự).
 */
export const PDF_MIN_CHARS_PER_PAGE = 24

const meaningfulChars = (text: string): number => text.replace(/[^\p{L}\p{N}]/gu, "").length

/** PDF gần như không có chữ so với số trang ⇒ không đọc được (bản scan). */
export const isPdfWithoutText = (text: string, pages: number): boolean => meaningfulChars(text) < PDF_MIN_CHARS_PER_PAGE * Math.max(1, pages)

const readPdf = async (buffer: Buffer): Promise<ParsedFileContent> => {
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

/** Gói zip (OOXML) bắt đầu bằng `PK\x03\x04`; .doc Word 97-2003 là file nhị phân OLE, mammoth không đọc được. */
const isZip = (buffer: Buffer): boolean => buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04

/** Hình trong thân .docx: ảnh (`a:blip`, ảnh VML cũ `v:imagedata`) và biểu đồ (`c:chart`). Ảnh ở header / footer (logo) không tính. */
const BODY_IMAGE_RE = /<(?:a:blip|v:imagedata|c:chart)\b/

const docxHasImages = async (buffer: Buffer): Promise<boolean> => {
  try {
    const zip = await JSZip.loadAsync(buffer)
    const body = zip.file("word/document.xml")
    if (body) return BODY_IMAGE_RE.test(await body.async("string"))
    return Object.keys(zip.files).some((name) => name.startsWith("word/media/") && !zip.files[name].dir)
  } catch {
    return false
  }
}

const readDocx = async (buffer: Buffer, ext: string): Promise<ParsedFileContent> => {
  if (!isZip(buffer)) {
    throw new Error(
      ext === ".doc"
        ? "File .doc (Word 97-2003) chưa đọc được. Mở bằng Word, lưu lại thành .docx rồi tải lên."
        : "File không phải .docx hợp lệ (có thể hỏng hoặc đổi đuôi). Mở bằng Word, lưu lại thành .docx rồi tải lên."
    )
  }
  const mammoth = require("mammoth")
  const result = await mammoth.extractRawText({ buffer })
  const text = (result.value as string).trim()
  const warnings: FileTextWarning[] = (await docxHasImages(buffer)) ? ["images_skipped"] : []
  return { text, tokenCount: estimateTokenCount(text), warnings }
}

/**
 * Parse nội dung text từ file đã upload (Buffer từ Multer memoryStorage).
 * Trả về { text, tokenCount, warnings } hoặc throw Error nếu parse thất bại.
 * Dùng chung: tài liệu project (mode 2/3) và tài liệu bổ sung của change request (mode 1).
 */
export const parseFileContent = async (buffer: Buffer, mimeType: string, extension: string): Promise<ParsedFileContent> => {
  const ext = extension.toLowerCase()

  // PDF
  if (mimeType === "application/pdf" || ext === ".pdf") return readPdf(buffer)

  // DOCX / DOC (mammoth chỉ đọc .docx; .doc nhị phân cũ báo lý do rõ)
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword" ||
    ext === ".docx" ||
    ext === ".doc"
  ) {
    return readDocx(buffer, ext)
  }

  // TXT / MD — đọc trực tiếp từ buffer
  if (
    mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    ext === ".txt" ||
    ext === ".md"
  ) {
    const text = buffer.toString("utf-8").trim()
    return { text, tokenCount: estimateTokenCount(text), warnings: [] }
  }

  throw new Error(`Unsupported file type for parsing: mimeType=${mimeType}, ext=${extension}`)
}
