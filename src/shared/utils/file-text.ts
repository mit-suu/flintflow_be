import { DocxPackage, readBlocks } from "../../modules/docx-ooxml/index.js"
import { readPdf } from "./pdf-text.js"
import { estimateTokenCount, type FileTextWarning, type ParsedFileContent } from "./parsed-file-content.js"

export { estimateTokenCount, isPdfWithoutText, PDF_MIN_CHARS_PER_PAGE, type FileTextWarning, type ParsedFileContent } from "./parsed-file-content.js"

/** File đọc được ra chữ: PDF, DOCX/DOC, TXT/MD. */
export const isTextFile = (mimeType: string, extension: string): boolean => {
  const ext = extension.toLowerCase()
  return (
    ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "text/plain", "text/markdown"].includes(mimeType) ||
    [".pdf", ".docx", ".doc", ".txt", ".md"].includes(ext)
  )
}

/** Gói zip (OOXML) bắt đầu bằng `PK\x03\x04`; .doc Word 97-2003 là file nhị phân OLE, không đọc theo đường OOXML được. */
const isZip = (buffer: Buffer): boolean => buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04

/** Chữ của một block (bảng ⇒ nối các ô có chữ của từng hàng; ảnh không có chữ). */
const blockText = (b: { kind: string; text: string; rows: string[][] | null }): string =>
  b.kind === "table" ? (b.rows ?? []).map((r) => r.map((c) => c.trim()).filter(Boolean).join(" | ")).filter(Boolean).join("\n") : b.text

/**
 * FLF-458: dùng chung bộ đọc .docx với I-4 (`docx-ooxml`) thay cho mammoth riêng — vẫn một bộ đọc cho cả SRS và
 * tài liệu tham khảo. Ảnh trong thân tài liệu không có chữ (`image_ref` khác `null`) ⇒ cảnh báo `images_skipped`.
 */
const readDocx = async (buffer: Buffer, ext: string): Promise<ParsedFileContent> => {
  if (!isZip(buffer)) {
    throw new Error(
      ext === ".doc"
        ? "File .doc (Word 97-2003) chưa đọc được. Mở bằng Word, lưu lại thành .docx rồi tải lên."
        : "File không phải .docx hợp lệ (có thể hỏng hoặc đổi đuôi). Mở bằng Word, lưu lại thành .docx rồi tải lên."
    )
  }
  const pkg = await DocxPackage.load(buffer)
  const blocks = await readBlocks(pkg)
  const text = blocks
    .map((b) => blockText({ kind: b.kind, text: b.text, rows: b.rows ?? null }))
    .filter((t) => t.trim())
    .join("\n\n")
    .trim()
  const warnings: FileTextWarning[] = blocks.some((b) => b.image_ref) ? ["images_skipped"] : []
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

  // DOCX / DOC (bộ đọc OOXML chỉ đọc .docx; .doc nhị phân cũ báo lý do rõ)
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
