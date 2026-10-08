import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { validationError } from "../../shared/utils/validation-message.js"
import { newPasswordField } from "../../shared/utils/password-field.js"

// CỐ Ý không dùng `newPasswordField`: tài khoản tạo trước khi siết chuẩn vẫn phải đăng nhập được.
// Xem `shared/utils/password-policy.ts`.
export const loginSchema = z.object({
  email: z.string().email("Email không hợp lệ."),
  password: z.string().min(1, "Vui lòng nhập mật khẩu"),
  rememberMe: z.boolean().optional()
})

export type LoginDTO = z.infer<typeof loginSchema>

export const registerSchema = z.object({
  name: z.string().optional(),
  email: z.string().email("Email không hợp lệ."),
  password: newPasswordField
})

export type RegisterDTO = z.infer<typeof registerSchema>

export const resendVerificationSchema = z.object({
  email: z.string().email("Email không hợp lệ.")
})

export type ResendVerificationDTO = z.infer<typeof resendVerificationSchema>

const otpField = z.string().trim().regex(/^\d{6}$/, "Mã OTP phải gồm 6 chữ số")

export const verifyEmailConfirmSchema = z.object({
  email: z.string().email("Email không hợp lệ."),
  otp: otpField
})

export type VerifyEmailConfirmDTO = z.infer<typeof verifyEmailConfirmSchema>

export const forgotPasswordSchema = z.object({
  email: z.string().email("Email không hợp lệ.")
})

export type ForgotPasswordDTO = z.infer<typeof forgotPasswordSchema>

export const verifyResetOtpSchema = z.object({
  email: z.string().email("Email không hợp lệ."),
  otp: otpField
})

export type VerifyResetOtpDTO = z.infer<typeof verifyResetOtpSchema>

export const resetPasswordSchema = z.object({
  resetToken: z.string().min(1, "Phiên đặt lại mật khẩu không hợp lệ. Vui lòng yêu cầu mã OTP mới."),
  password: newPasswordField
})

export type ResetPasswordDTO = z.infer<typeof resetPasswordSchema>

export const googleAuthSchema = z.object({
  idToken: z.string().min(1, "Không nhận được thông tin đăng nhập Google. Vui lòng thử lại."),
  rememberMe: z.boolean().optional()
})

export type GoogleAuthDTO = z.infer<typeof googleAuthSchema>

export const validateRequest = (schema: z.ZodSchema) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      throw validationError(result.error)
    }
    req.body = result.data
    next()
  }
}
