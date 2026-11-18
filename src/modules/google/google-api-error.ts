/**
 * Đổi lỗi của Google (OAuth token endpoint, Drive / Docs API qua gaxios) thành `ApiError` có mã của contract, để mọi
 * tính năng Google Docs (xuất, nhập, MCP) báo cùng một câu cho cùng một tình huống.
 */
import { ApiError } from "../../shared/utils/api-error.js"

export const reconnectRequired = () =>
  new ApiError(401, "Cần kết nối lại tài khoản Google để tiếp tục.", "GOOGLE_RECONNECT_REQUIRED")

interface GoogleErrorShape {
  status?: unknown
  code?: unknown
  message?: unknown
  response?: { status?: unknown; data?: { error?: unknown } }
}

/**
 * Google trả `invalid_grant` khi mã uỷ quyền sai / đã dùng, hoặc refresh token bị thu hồi / hết hạn.
 * Lỗi của gaxios mang `response.data.error`; bản cũ chỉ có trong `message`.
 */
export const isInvalidGrant = (err: unknown): boolean => {
  const e = err as GoogleErrorShape | null
  return e?.response?.data?.error === "invalid_grant" || (typeof e?.message === "string" && e.message.includes("invalid_grant"))
}

/** HTTP status của lỗi gaxios (`response.status`, `status` hoặc `code` số tuỳ phiên bản). */
export const googleErrorStatus = (err: unknown): number | undefined => {
  const e = (err ?? {}) as GoogleErrorShape
  for (const value of [e.response?.status, e.status, e.code]) {
    if (typeof value === "number") return value
  }
  return undefined
}

/** `reason` trong `{ error: { errors: [{ reason }] } }` — Drive dùng cùng mã 403 cho cả "cấm" lẫn "hết hạn mức". */
const reasonsOf = (e: GoogleErrorShape): string[] => {
  const error = e.response?.data?.error as { errors?: Array<{ reason?: unknown }> } | undefined
  return (error?.errors ?? []).map((item) => item.reason).filter((r): r is string => typeof r === "string")
}

const QUOTA_REASONS = new Set([
  "storageQuotaExceeded",
  "quotaExceeded",
  "userRateLimitExceeded",
  "rateLimitExceeded",
  "dailyLimitExceeded",
  "sharingRateLimitExceeded"
])

/** Lỗi Google đã biết ⇒ `ApiError`; lỗi khác (mạng, 5xx) trả nguyên để lên 500 và được log. */
export const toGoogleApiError = (err: unknown): unknown => {
  if (err instanceof ApiError) return err
  const e = (err ?? {}) as GoogleErrorShape
  const status = googleErrorStatus(err)
  if (isInvalidGrant(err) || status === 401) return reconnectRequired()
  if (status === 429 || reasonsOf(e).some((reason) => QUOTA_REASONS.has(reason))) {
    return new ApiError(
      503,
      "Google Drive đang giới hạn (hết dung lượng hoặc quá nhiều lượt gọi). Vui lòng thử lại sau hoặc giải phóng dung lượng Drive.",
      "GOOGLE_DRIVE_QUOTA_EXCEEDED"
    )
  }
  if (status === 403) return new ApiError(403, "Google Drive từ chối truy cập file này.", "GOOGLE_FILE_FORBIDDEN")
  if (status === 404) return new ApiError(404, "Không tìm thấy file trên Google Drive (có thể đã bị xoá).", "GOOGLE_FILE_NOT_FOUND")
  return err
}
