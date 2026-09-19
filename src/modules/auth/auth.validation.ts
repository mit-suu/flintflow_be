import { z } from "zod"
import { Request, Response, NextFunction } from "express"
import { ApiError } from "../../shared/utils/api-error.js"

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  rememberMe: z.boolean().optional()
})

export type LoginDTO = z.infer<typeof loginSchema>

export const registerSchema = z.object({
  name: z.string().optional(),
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters")
})

export type RegisterDTO = z.infer<typeof registerSchema>

export const resendVerificationSchema = z.object({
  email: z.string().email("Invalid email address")
})

export type ResendVerificationDTO = z.infer<typeof resendVerificationSchema>

const otpField = z.string().trim().regex(/^\d{6}$/, "Mã OTP phải gồm 6 chữ số")

export const verifyEmailConfirmSchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: otpField
})

export type VerifyEmailConfirmDTO = z.infer<typeof verifyEmailConfirmSchema>

export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address")
})

export type ForgotPasswordDTO = z.infer<typeof forgotPasswordSchema>

export const verifyResetOtpSchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: otpField
})

export type VerifyResetOtpDTO = z.infer<typeof verifyResetOtpSchema>

export const resetPasswordSchema = z.object({
  resetToken: z.string().min(1, "Reset token is required"),
  password: z.string().min(6, "Password must be at least 6 characters")
})

export type ResetPasswordDTO = z.infer<typeof resetPasswordSchema>

export const googleAuthSchema = z.object({
  idToken: z.string().min(1, "Google ID token is required"),
  rememberMe: z.boolean().optional()
})

export type GoogleAuthDTO = z.infer<typeof googleAuthSchema>

export const validateRequest = (schema: z.ZodSchema) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const errorMessage = result.error.issues.map((issue) => issue.message).join(", ")
      throw new ApiError(400, errorMessage, "VALIDATION_ERROR")
    }
    req.body = result.data
    next()
  }
}
