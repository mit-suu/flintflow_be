import { z } from "zod"
import { ApiError } from "./api-error.js"

/**
 * Câu lỗi cho user khi body/query/params sai schema (FLF-247).
 *
 * Trước đây controller trả nguyên `z.prettifyError(err)` (`✖ Invalid input → at base_version`) hoặc nối message
 * mặc định của Zod — user đọc không hiểu. Quy tắc mới:
 *   - mọi issue đều mang câu do schema tự viết (`z.string().min(1, "Tên không được để trống")`) ⇒ nối các câu đó;
 *   - còn issue nào chỉ có câu mặc định của Zod ⇒ một câu chung, vì lỗi đó là lỗi của client chứ không phải của
 *     user (field thiếu, sai kiểu) — user chỉ làm được việc tải lại trang.
 * Chi tiết từng issue (`path`, `message`) đi vào `meta.issues` để debug.
 */

export const GENERIC_VALIDATION_MESSAGE = "Dữ liệu gửi lên không hợp lệ. Vui lòng tải lại trang rồi thử lại."

/**
 * Dấu trên issue mà message lấy từ bản dịch mặc định (không phải câu schema tự viết). Zod gọi `customError` toàn cục
 * CHỈ khi schema không tự đặt message, trước khi tách `rest` khỏi issue — nên gắn dấu ở đây là phân biệt được.
 * Dùng Symbol để dấu không lọt vào JSON.
 */
const DEFAULT_MESSAGE = Symbol("zodDefaultMessage")

let installed = false

/**
 * Cài một lần: móc đánh dấu issue dùng câu mặc định. `customError` trả `undefined` ⇒ Zod rơi xuống `localeError`
 * như bình thường, không đổi nội dung câu. Không đổi locale: câu mặc định không bao giờ tới user (thay bằng câu
 * chung), còn câu lỗi gửi lại cho model khi retry (response-parser, op-validator) giữ nguyên như trước.
 */
export const installZodLocale = (): void => {
  if (installed) return
  installed = true
  z.config({
    customError: (issue) => {
      ;(issue as unknown as Record<symbol, unknown>)[DEFAULT_MESSAGE] = true
      return undefined
    }
  })
}

installZodLocale()

export interface ValidationIssue {
  path: string
  message: string
}

const isDefaultMessage = (issue: z.core.$ZodIssue): boolean =>
  (issue as unknown as Record<symbol, unknown>)[DEFAULT_MESSAGE] === true

export const validationIssues = (error: z.ZodError): ValidationIssue[] =>
  error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }))

/** Câu hiện cho user — xem quy tắc ở đầu file. */
export const validationMessage = (error: z.ZodError): string => {
  const issues = error.issues
  if (issues.length === 0 || issues.some(isDefaultMessage)) return GENERIC_VALIDATION_MESSAGE
  const messages = [...new Set(issues.map((issue) => issue.message.trim()).filter(Boolean))]
  return messages.length > 0 ? messages.join("; ") : GENERIC_VALIDATION_MESSAGE
}

/** `meta` kèm envelope 400 — chi tiết cho debug, không hiện cho user. */
export const validationMeta = (error: z.ZodError): { issues: ValidationIssue[] } => ({ issues: validationIssues(error) })

/** `400 VALIDATION_ERROR` với câu cho user + `meta.issues` — thay cho `new ApiError(400, z.prettifyError(err), …)`. */
export const validationError = (error: z.ZodError): ApiError =>
  new ApiError(400, validationMessage(error), "VALIDATION_ERROR", { ...validationMeta(error) })
