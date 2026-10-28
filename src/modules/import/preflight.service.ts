/**
 * Preflight file upload (I-1, nút 1.2) — tất định, không tốn credit. FLF-171, plan §6 2B; spike P0 §4.6.
 * Nhận loại file theo magic bytes (không theo đuôi): `.doc`, `.docx` có mật khẩu (vỏ OLE), không phải zip.
 * Track Changes/comment của tác giả không phải mã CR (`CR-001`…) ⇒ từ chối kèm vị trí để người dùng
 * Accept/Reject trong Word rồi upload lại. Đọc stamp để service chọn nhánh (không stamp / đúng project / project khác).
 * FLF-331: nhận diện SRS / mẫu SRS bằng Code (`srs-detect.ts`) — CV, hoá đơn, test plan… bị từ chối `NOT_SRS` trước khi tốn credit.
 */

import { DocxPackage, MAIN_PART, OoxmlError, enclosingParagraph, listComments, listRevisions, readBlocks, readStamp, commentParagraph } from "../docx-ooxml/index.js"
import type { OoxmlBlock, Stamp } from "../docx-ooxml/index.js"
import { CR_AUTHOR_PATTERN, IMPORT_MAX_FILE_BYTES, fileTooLargeMessage } from "./import.constants.js"
import type { PreflightIssue } from "./imported-document.model.js"
import { classifyDocument, type DocumentKindResult } from "./srs-detect.js"

export interface PreflightResult {
  status: "accepted" | "rejected"
  issues: PreflightIssue[]
  stamp: Stamp | null
  /**
   * FLF-331: loại tài liệu Code nhận ra (0 credit). `null` khi chưa tới bước đọc khối, hoặc file mang dấu version
   * FlintFlow (chắc chắn là SRS của hệ thống, không phân loại lại). `unknown` ⇒ vẫn nhận, FE cảnh báo ở bước xác nhận.
   */
  document_kind: DocumentKindResult | null
}

const OLE_MAGIC = "d0cf11e0"
const ZIP_MAGIC = "504b0304"
const utf16 = (s: string): Buffer => Buffer.from(s, "utf16le")

const reject = (code: PreflightIssue["code"], message: string, extra: Partial<PreflightResult> = {}): PreflightResult => ({
  status: "rejected",
  issues: [{ code, message, location: null }],
  stamp: null,
  document_kind: null,
  ...extra
})

const locationOf = (blocksByElement: Map<Element, OoxmlBlock>, p: Element | null): PreflightIssue["location"] => {
  const block = p ? blocksByElement.get(p) : undefined
  return block ? { block_ord: block.ordinal, text: block.text.slice(0, 80) } : null
}

const REVISION_LABEL: Record<string, string> = {
  ins: "sửa chữ",
  del: "sửa chữ",
  moveFrom: "sửa chữ",
  moveTo: "sửa chữ",
  rPrChange: "đổi định dạng",
  pPrChange: "đổi định dạng"
}

export const preflightDocx = async (data: Buffer, opts: { maxBytes?: number } = {}): Promise<PreflightResult> => {
  const maxBytes = opts.maxBytes ?? IMPORT_MAX_FILE_BYTES
  if (data.length > maxBytes) return reject("FILE_TOO_LARGE", fileTooLargeMessage(data.length))
  const magic = data.subarray(0, 4).toString("hex")
  if (magic === OLE_MAGIC) {
    if (data.includes(utf16("EncryptionInfo")) || data.includes(utf16("EncryptedPackage"))) {
      return reject("FILE_ENCRYPTED", "File có mật khẩu. Hãy gỡ mật khẩu trong Word rồi upload lại")
    }
    if (data.includes(utf16("WordDocument"))) {
      return reject("LEGACY_DOC", "File .doc (Word 97-2003). Hãy mở bằng Word và lưu lại dạng .docx")
    }
    return reject("NOT_DOCX", "File không phải tài liệu Word .docx")
  }
  if (magic !== ZIP_MAGIC) return reject("NOT_DOCX", "File không phải tài liệu Word .docx")

  let pkg: DocxPackage
  try {
    pkg = await DocxPackage.load(data)
  } catch (err) {
    if (err instanceof OoxmlError && err.code === "PACKAGE_TOO_LARGE") return reject("FILE_TOO_LARGE", "Nội dung file sau giải nén quá lớn. Hãy nén ảnh trong Word (File → Compress Pictures) hoặc tách phụ lục rồi tải lại.")
    return reject("CORRUPT_ZIP", "File .docx bị hỏng, không mở được")
  }
  if (!pkg.has(MAIN_PART)) return reject("NOT_DOCX", "File zip không phải tài liệu Word (thiếu word/document.xml)")

  let blocks: OoxmlBlock[]
  try {
    blocks = await readBlocks(pkg)
  } catch {
    return reject("CORRUPT_ZIP", "Nội dung tài liệu bị hỏng (XML không hợp lệ)")
  }
  if (!blocks.some((b) => b.text.trim())) return reject("EMPTY_DOCUMENT", "Tài liệu không có nội dung chữ")

  // FLF-331 (I-1): có phải SRS / mẫu SRS không — bằng Code, trước mọi lượt gọi model. File mang dấu version FlintFlow
  // là bản chính hệ thống xuất ra (kể cả bản tải lại) ⇒ không phân loại lại.
  const stamp = await readStamp(pkg)
  const documentKind = stamp ? null : classifyDocument(blocks)
  if (documentKind?.kind === "not_srs") {
    return reject("NOT_SRS", documentKind.reasons[0] ?? "Không thấy dấu hiệu đây là tài liệu yêu cầu (SRS) hay mẫu SRS", { stamp, document_kind: documentKind })
  }

  const byElement = new Map(blocks.map((b) => [b.element, b]))
  const issues: PreflightIssue[] = []
  // Một lần sửa trong Word thường sinh cặp del + ins: gộp theo (thông báo, đoạn)
  const seen = new Set<string>()
  const push = (issue: PreflightIssue): void => {
    const key = `${issue.message}|${issue.location?.block_ord ?? "-"}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push(issue)
  }
  for (const rev of await listRevisions(pkg)) {
    if (CR_AUTHOR_PATTERN.test(rev.author)) continue
    push({
      code: "FOREIGN_TRACK_CHANGE",
      message: `Track Changes (${REVISION_LABEL[rev.kind] ?? rev.kind}) của "${rev.author || "không rõ"}" chưa được Accept/Reject`,
      location: locationOf(byElement, enclosingParagraph(rev.element))
    })
  }
  for (const c of await listComments(pkg)) {
    if (CR_AUTHOR_PATTERN.test(c.author)) continue
    push({
      code: "FOREIGN_COMMENT",
      message: `Comment của "${c.author || "không rõ"}" chưa được xử lý`,
      location: locationOf(byElement, await commentParagraph(pkg, c.id))
    })
  }
  // Không đủ dấu hiệu SRS / mẫu SRS (bài luận, ghi chú, báo cáo lab…) ⇒ cũng chặn: file không liên quan không vào luồng import
  // (kể cả làm mẫu bắt buộc). Xét sau cùng — file có lỗi khác (Track Changes, comment) báo lỗi đó trước để sửa một lượt. SRS
  // viết tự do vẫn có từ khoá + mã yêu cầu nên ra `srs`, không rơi vào đây.
  if (!issues.length && documentKind?.kind === "unknown") {
    issues.push({
      code: "NOT_SRS",
      message:
        "Không đủ dấu hiệu đây là tài liệu đặc tả yêu cầu (SRS) hay mẫu SRS: không có mục Use Case, Requirements, Actor hay mã yêu cầu (UC-01, FR-01). Hãy tải đúng file SRS (hoặc mẫu SRS).",
      location: null
    })
  }
  return { status: issues.length ? "rejected" : "accepted", issues, stamp, document_kind: documentKind }
}
