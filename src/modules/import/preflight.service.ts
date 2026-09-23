/**
 * Preflight file upload (I-1, nút 1.2) — tất định, không tốn credit. FLF-171, plan §6 2B; spike P0 §4.6.
 * Nhận loại file theo magic bytes (không theo đuôi): `.doc`, `.docx` có mật khẩu (vỏ OLE), không phải zip.
 * Track Changes/comment của tác giả không phải mã CR (`CR-001`…) ⇒ từ chối kèm vị trí để người dùng
 * Accept/Reject trong Word rồi upload lại. Đọc stamp để service chọn nhánh (không stamp / đúng project / project khác).
 */

import { DocxPackage, MAIN_PART, OoxmlError, enclosingParagraph, listComments, listRevisions, readBlocks, readStamp, commentParagraph } from "../docx-ooxml/index.js"
import type { OoxmlBlock, Stamp } from "../docx-ooxml/index.js"
import { CR_AUTHOR_PATTERN, IMPORT_MAX_FILE_BYTES } from "./import.constants.js"
import type { PreflightIssue } from "./imported-document.model.js"

export interface PreflightResult {
  status: "accepted" | "rejected"
  issues: PreflightIssue[]
  stamp: Stamp | null
}

const OLE_MAGIC = "d0cf11e0"
const ZIP_MAGIC = "504b0304"
const utf16 = (s: string): Buffer => Buffer.from(s, "utf16le")

const reject = (code: PreflightIssue["code"], message: string): PreflightResult => ({
  status: "rejected",
  issues: [{ code, message, location: null }],
  stamp: null
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
  if (data.length > maxBytes) return reject("FILE_TOO_LARGE", `File ${data.length} byte vượt giới hạn ${maxBytes} byte`)
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
    if (err instanceof OoxmlError && err.code === "PACKAGE_TOO_LARGE") return reject("FILE_TOO_LARGE", "File giải nén quá lớn")
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
  return { status: issues.length ? "rejected" : "accepted", issues, stamp: await readStamp(pkg) }
}
