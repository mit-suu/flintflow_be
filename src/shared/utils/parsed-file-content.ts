/**
 * FLF-458: kiểu + hàm thuần dùng chung giữa `file-text.ts` (DOCX/TXT/MD) và `pdf-text.ts` (PDF) — tách riêng để
 * hai bộ đọc không phải import vòng qua nhau.
 */

/**
 * Ước lượng số token từ độ dài chuỗi.
 * Dùng tỷ lệ ~4 ký tự/token theo OpenAI estimation.
 * Không cần thư viện tokenizer chính xác ở giai đoạn này.
 */
export const estimateTokenCount = (text: string): number => {
  return Math.ceil(text.length / 4)
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
