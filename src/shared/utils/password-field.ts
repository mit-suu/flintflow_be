import { z } from "zod"
import { checkPassword, PASSWORD_ISSUE_MESSAGES } from "./password-policy.js"

/**
 * Mật khẩu MỚI (đăng ký · đặt lại qua OTP · đổi mật khẩu) — phải đạt chuẩn ở `password-policy.ts`.
 * Cố ý KHÔNG dùng cho đăng nhập: tài khoản cũ có thể yếu hơn chuẩn mới, siết ở đó là khoá họ ra ngoài.
 */
export const newPasswordField = z.string().superRefine((value, ctx) => {
  const issue = checkPassword(value)
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: PASSWORD_ISSUE_MESSAGES[issue] })
})
