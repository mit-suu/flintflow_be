/**
 * google-import.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Lấy một file người dùng chọn trong Google Picker về dạng `.docx` để đi đúng luồng import có sẵn
 * (`importService.uploadImport`): Google Doc ⇒ `files.export` sang Word; file `.docx` trên Drive ⇒ tải nguyên file.
 *
 * Với quyền `drive.file`, Drive chỉ cho đọc file app tạo hoặc file người dùng vừa chọn trong Picker.
 */
import { drive as createDrive } from "@googleapis/drive"
import type { OAuth2Client } from "google-auth-library"
import { ApiError } from "../../shared/utils/api-error.js"
import { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILE_MB, fileTooLargeMessage } from "../import/import.constants.js"
import type { UploadedFile } from "../import/import.service.js"
import { GOOGLE_DOC_MIME } from "./google-export.service.js"
import { toGoogleApiError } from "./google-api-error.js"

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

const unsupported = () =>
  new ApiError(400, "Chỉ nhập được Google Docs hoặc file Word (.docx) từ Google Drive.", "GOOGLE_FILE_UNSUPPORTED")

/** Drive từ chối xuất Google Doc quá lớn (giới hạn ~10 MB mỗi file xuất) bằng 403 `exportSizeLimitExceeded`. */
const isExportTooLarge = (err: unknown): boolean => {
  const errors = (err as { response?: { data?: { error?: { errors?: Array<{ reason?: unknown }> } } } })?.response?.data?.error?.errors
  return (errors ?? []).some((item) => item.reason === "exportSizeLimitExceeded")
}

const withDocxExtension = (name: string): string => (/\.docx$/i.test(name) ? name : `${name}.docx`)

/**
 * Tải file Drive về `UploadedFile`. File `.docx` quá gấp đôi giới hạn import ⇒ 413 `FILE_TOO_LARGE` như upload từ máy
 * (hơi quá cỡ vẫn tải để preflight trả lỗi có bản ghi, giống multer ở `import.controller.ts`).
 */
export const fetchDocxFromDrive = async (auth: OAuth2Client, fileId: string): Promise<UploadedFile> => {
  const drive = createDrive({ version: "v3", auth })
  try {
    const { data: meta } = await drive.files.get({ fileId, fields: "id,name,mimeType,size,trashed" })
    if (meta.trashed) {
      throw new ApiError(404, "Không tìm thấy file trên Google Drive (có thể đã bị xoá).", "GOOGLE_FILE_NOT_FOUND")
    }
    const name = meta.name ?? "Google Doc"

    let data: ArrayBuffer
    if (meta.mimeType === GOOGLE_DOC_MIME) {
      try {
        data = (await drive.files.export({ fileId, mimeType: DOCX_MIME }, { responseType: "arraybuffer" })).data as unknown as ArrayBuffer
      } catch (err) {
        if (isExportTooLarge(err)) {
          throw new ApiError(
            413,
            "Google Doc này quá lớn để Google chuyển sang Word. Hãy tải file về dạng .docx (Tệp > Tải xuống) rồi tải lên từ máy.",
            "GOOGLE_EXPORT_TOO_LARGE"
          )
        }
        throw err
      }
    } else if (meta.mimeType === DOCX_MIME) {
      if (Number(meta.size ?? 0) > IMPORT_MAX_FILE_BYTES * 2) {
        throw new ApiError(413, fileTooLargeMessage(), "FILE_TOO_LARGE", { max_mb: IMPORT_MAX_FILE_MB })
      }
      data = (await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" })).data as unknown as ArrayBuffer
    } else {
      throw unsupported()
    }

    const buffer = Buffer.from(data)
    return { buffer, originalname: withDocxExtension(name), size: buffer.length }
  } catch (err) {
    throw toGoogleApiError(err)
  }
}
