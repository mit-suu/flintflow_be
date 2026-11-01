import { ApiError } from "../utils/api-error.js"

/**
 * UC-03 / UC-66: tài khoản bị khoá ⇒ 403 `ACCOUNT_SUSPENDED`. `meta` mang lý do Administrator nhập lúc khoá (UC-60)
 * và thời điểm khoá để màn đăng nhập nói cho người dùng biết vì sao (FLF-345). Dùng chung cho đăng nhập, refresh
 * và `requireActiveAccount` để mọi đường bị chặn đều trả cùng một shape.
 */
export const accountSuspendedError = (user: {
  suspendReason?: string | null
  suspendedAt?: Date | null
}): ApiError =>
  new ApiError(403, "Tài khoản đã bị khoá", "ACCOUNT_SUSPENDED", {
    reason: user.suspendReason ?? null,
    suspended_at: user.suspendedAt ? new Date(user.suspendedAt).toISOString() : null
  })
