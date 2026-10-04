import { z } from "zod"
import { ApiError } from "./api-error.js"
import { AiActionError } from "../ai/ai-action.types.js"
import { validationMessage, validationMeta } from "./validation-message.js"

/**
 * Lỗi bất kỳ → `{ status, code, message, meta }` an toàn để gửi cho user (FLF-247).
 *
 * `message` luôn là một câu tiếng Việt người đọc được: không mã lỗi, không path op, không dump Zod, không text thô
 * của thư viện / nhà cung cấp AI, không tên biến môi trường. Chi tiết kỹ thuật vẫn được người gọi log đầy đủ
 * (`console.error`) và — khi hữu ích cho debug — đi vào `meta`, không bao giờ vào `message`.
 *
 * Dùng chung cho error handler HTTP và các luồng SSE (sự kiện `error`, `run-state`), để hai đường nói cùng một câu.
 */

export interface ClientError {
  status: number
  code: string
  message: string
  meta?: Record<string, unknown>
}

export const GENERIC_SERVER_MESSAGE = "Hệ thống gặp lỗi khi xử lý yêu cầu. Vui lòng thử lại sau."
export const GENERIC_BAD_REQUEST_MESSAGE = "Yêu cầu không hợp lệ."
export const AI_UNAVAILABLE_MESSAGE = "Dịch vụ AI đang gặp sự cố. Vui lòng thử lại sau ít phút."
export const AI_OVERLOADED_MESSAGE = "Dịch vụ AI đang quá tải. Vui lòng thử lại sau ít phút."
export const AI_BAD_OUTPUT_MESSAGE = "AI trả kết quả không đúng dạng. Thử lại, hoặc nói rõ hơn yêu cầu."
export const AI_NOT_CONFIGURED_MESSAGE = "Dịch vụ AI chưa được cấu hình. Vui lòng liên hệ quản trị viên."
export const RUN_CANCELLED_MESSAGE = "Lượt chạy đã bị huỷ."

/** Origin không nằm trong whitelist CORS (production) — `app.ts` ném lỗi này cho `cors()`. */
export class CorsRejectedError extends Error {
  constructor(readonly origin: string) {
    super(`CORS: Origin '${origin}' is not allowed`)
    this.name = "CorsRejectedError"
  }
}

// ─── lỗi gọi AI ─────────────────────────────────────────────────

const AI_OVERLOADED = /(^RATE_LIMIT_EXCEEDED$|_OVERLOADED$)/
const AI_BAD_OUTPUT = new Set(["PARSE_FAILED", "SCHEMA_MISMATCH", "RESPONSE_TRUNCATED"])
const AI_NOT_CONFIGURED = /(_KEY_MISSING|_NOT_CONFIGURED|_UNSUPPORTED|_CREDENTIALS_MISSING|_NO_VISION)$/

/**
 * Câu của AiActionError. Chỉ INSUFFICIENT_CREDIT giữ câu gốc ("Không đủ credit. Yêu cầu: … Khả dụng: …") — các mã
 * khác mang text của nhà cung cấp (`finish_reason=…`, câu tiếng Anh của Gemini/GLM) hoặc tên biến môi trường.
 */
export const aiErrorMessage = (code: string, message: string): string => {
  if (code === "INSUFFICIENT_CREDIT") return message
  if (code === "RUN_CANCELLED" || code === "AI_CALL_ABORTED") return RUN_CANCELLED_MESSAGE
  if (code === "CREDIT_LEDGER_INCONSISTENT") return GENERIC_SERVER_MESSAGE
  if (AI_OVERLOADED.test(code)) return AI_OVERLOADED_MESSAGE
  if (AI_BAD_OUTPUT.has(code)) return AI_BAD_OUTPUT_MESSAGE
  if (AI_NOT_CONFIGURED.test(code)) return AI_NOT_CONFIGURED_MESSAGE
  return AI_UNAVAILABLE_MESSAGE
}

const aiErrorMeta = (err: AiActionError): Record<string, unknown> | undefined => {
  const details = err.details && typeof err.details === "object" ? (err.details as Record<string, unknown>) : undefined
  if (!details) return undefined
  // INSUFFICIENT_CREDIT: { cost, available, balance, reserved } — FE cần để hiện số credit. Lỗi provider chỉ đưa logId
  // (đủ để tra log), không đưa nguyên response của nhà cung cấp.
  if (err.code === "INSUFFICIENT_CREDIT") return { ...details }
  return typeof details.logId === "string" ? { logId: details.logId } : undefined
}

// ─── lỗi lô op (TransactionRejectedError, nhận theo dạng để shared/ không phụ thuộc modules/spine) ─────

interface ViolationLike {
  rule: string
  message: string
  path?: string
  op_index?: number
}

const PATH_RULES = new Set(["path_invalid", "path_not_resolved", "path_ambiguous", "index_selector_forbidden"])

export const CHANGE_TARGET_NOT_FOUND_MESSAGE =
  "Không tìm thấy mục cần sửa. Hãy nói rõ tên mục (ví dụ: màn “Đặt lịch”, chức năng “Huỷ lịch”)."
export const CHANGE_DUPLICATE_MESSAGE = "Mục này đã tồn tại trong tài liệu."
export const CHANGE_INVALID_RESULT_MESSAGE =
  "Chưa áp được thay đổi này vì dữ liệu sau khi sửa không hợp lệ. Hãy diễn đạt lại yêu cầu rồi thử lại."

/** Câu cho một lô op bị từ chối — theo luật của vi phạm đầu tiên; path/op/mã luật ở `meta.violations`. */
export const violationMessage = (violations: readonly ViolationLike[]): string => {
  const rule = violations[0]?.rule ?? ""
  if (PATH_RULES.has(rule)) return CHANGE_TARGET_NOT_FOUND_MESSAGE
  if (rule === "duplicate_id") return CHANGE_DUPLICATE_MESSAGE
  if (rule === "op_value_missing") return "Không tìm thấy thay đổi nào cần làm theo lệnh này."
  if (rule === "path_not_writable") return "Phần này do hệ thống tự cập nhật, không sửa trực tiếp được."
  if (rule === "revert_conflict") return "Nội dung này đã được sửa lại sau đó nên không hoàn tác được."
  if (rule === "invariant_1_required_section" || rule === "invariant_2_last_element") {
    return "Không xoá được mục này vì tài liệu cần giữ ít nhất một mục ở phần đó."
  }
  if (rule === "invariant_8_cursor_screen") return "Không xoá được màn đang được soạn chi tiết."
  return CHANGE_INVALID_RESULT_MESSAGE
}

const isTransactionRejected = (err: ApiError): err is ApiError & { violations: ViolationLike[]; referrers?: unknown[] } =>
  (err.code === "OP_INVALID" || err.code === "INVARIANT_VIOLATION") && Array.isArray((err as { violations?: unknown }).violations)

const apiErrorMeta = (err: ApiError): Record<string, unknown> | undefined =>
  err.meta && typeof err.meta === "object" ? err.meta : undefined

// ─── lỗi thư viện ────────────────────────────────────────────────

type LooseError = Error & {
  type?: unknown
  code?: unknown
  status?: unknown
  statusCode?: unknown
}

const NON_API_STATUS_CODE: Readonly<Record<number, string>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMIT_EXCEEDED"
}

const numericStatus = (err: LooseError): number | null => {
  const status = typeof err.statusCode === "number" ? err.statusCode : typeof err.status === "number" ? err.status : null
  return status !== null && Number.isInteger(status) && status >= 400 && status < 600 ? status : null
}

export const toClientError = (err: unknown): ClientError => {
  if (err instanceof ApiError) {
    if (isTransactionRejected(err)) {
      return {
        status: err.statusCode,
        code: err.code,
        message: violationMessage(err.violations),
        meta: { violations: err.violations, referrers: err.referrers ?? [] }
      }
    }
    const meta = apiErrorMeta(err)
    return { status: err.statusCode, code: err.code, message: err.message, ...(meta ? { meta } : {}) }
  }

  if (err instanceof AiActionError) {
    const meta = aiErrorMeta(err)
    const status = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500
    return { status, code: err.code, message: aiErrorMessage(err.code, err.message), ...(meta ? { meta } : {}) }
  }

  if (err instanceof z.ZodError) {
    return { status: 400, code: "VALIDATION_ERROR", message: validationMessage(err), meta: validationMeta(err) }
  }

  if (err instanceof CorsRejectedError) {
    return { status: 403, code: "CORS_FORBIDDEN", message: "Yêu cầu không được phép từ địa chỉ này." }
  }

  if (!(err instanceof Error)) {
    return { status: 500, code: "INTERNAL_SERVER_ERROR", message: GENERIC_SERVER_MESSAGE }
  }

  const e = err as LooseError

  // body-parser (express.json / urlencoded)
  if (e.type === "entity.parse.failed") {
    return { status: 400, code: "BAD_REQUEST", message: "Dữ liệu gửi lên không đọc được. Vui lòng thử lại." }
  }
  if (e.type === "entity.too.large") {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Dữ liệu gửi lên quá lớn." }
  }

  // multer
  if (e.name === "MulterError") {
    if (e.code === "LIMIT_FILE_SIZE") {
      return { status: 413, code: "FILE_TOO_LARGE", message: "File quá lớn so với giới hạn cho phép." }
    }
    return { status: 400, code: "UPLOAD_FAILED", message: "Không tải file lên được. Vui lòng chọn lại file rồi thử lại." }
  }

  // mongoose / mongo
  if (e.name === "CastError") {
    return { status: 400, code: "INVALID_ID", message: "Đường dẫn hoặc mã định danh không hợp lệ." }
  }
  if (e.code === 11000) {
    return { status: 409, code: "DUPLICATE", message: "Dữ liệu này đã tồn tại." }
  }
  if (e.name === "ValidationError") {
    return { status: 400, code: "VALIDATION_ERROR", message: "Dữ liệu không hợp lệ." }
  }

  const status = numericStatus(e)
  if (status !== null && status < 500) {
    return { status, code: NON_API_STATUS_CODE[status] ?? "BAD_REQUEST", message: GENERIC_BAD_REQUEST_MESSAGE }
  }
  return { status: 500, code: "INTERNAL_SERVER_ERROR", message: GENERIC_SERVER_MESSAGE }
}

/** Câu cho user của một lỗi bất kỳ — rút gọn của `toClientError(err).message`. */
export const clientErrorMessage = (err: unknown): string => toClientError(err).message
