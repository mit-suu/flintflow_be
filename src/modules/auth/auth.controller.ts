import { Request, Response } from "express"
import * as authService from "./auth.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { env } from "../../config/env.js"
import { EMAIL_OTP_TTL_MS, RESET_PASSWORD_GRANT_TTL_MS } from "./auth.service.js"
import {
  LoginDTO,
  RegisterDTO,
  ResendVerificationDTO,
  VerifyEmailConfirmDTO,
  ForgotPasswordDTO,
  VerifyResetOtpDTO,
  ResetPasswordDTO,
  GoogleAuthDTO
} from "./auth.validation.js"
import {
  ACCESS_COOKIE_MAX_AGE_MS,
  REFRESH_COOKIE_MAX_AGE_MS,
  REMEMBER_ME_MAX_AGE_MS,
  authCookieOptions
} from "../../shared/auth/auth-cookie.js"

const getBaseCookieOptions = () =>
  authCookieOptions({ nodeEnv: env.NODE_ENV, sameSite: env.COOKIE_SAME_SITE, domain: env.COOKIE_DOMAIN })

const getCookieOptions = () => ({ ...getBaseCookieOptions(), maxAge: REFRESH_COOKIE_MAX_AGE_MS })

const getAccessTokenCookieOptions = () => ({ ...getBaseCookieOptions(), maxAge: ACCESS_COOKIE_MAX_AGE_MS })

/**
 * Đặt cookie phiên theo ô "Ghi nhớ tài khoản":
 * - `true`: refresh cookie 30 ngày;
 * - `false`: cookie phiên (không `maxAge`) ⇒ đóng trình duyệt là mất, phải đăng nhập lại;
 * - `null`: như cũ (3 ngày).
 */
const setAuthCookies = (
  res: Response,
  tokens: { accessToken: string; refreshToken: string; rememberMe: boolean | null }
) => {
  const base = getBaseCookieOptions()
  if (tokens.rememberMe === false) {
    res.cookie("refreshToken", tokens.refreshToken, base)
    res.cookie("accessToken", tokens.accessToken, base)
    return
  }
  const refreshOptions = tokens.rememberMe ? { ...base, maxAge: REMEMBER_ME_MAX_AGE_MS } : getCookieOptions()
  res.cookie("refreshToken", tokens.refreshToken, refreshOptions)
  res.cookie("accessToken", tokens.accessToken, getAccessTokenCookieOptions())
}

const clearAuthCookies = (res: Response) => {
  res.clearCookie("refreshToken", getBaseCookieOptions())
  res.clearCookie("accessToken", getBaseCookieOptions())
}

export const register = catchAsync(async (req: Request, res: Response) => {
  const { email, password, name } = req.body as RegisterDTO & { name?: string }

  const result = await authService.register(email, password, name)

  return sendSuccess(res, 201, {
    user: result.user,
    otpExpiresIn: EMAIL_OTP_TTL_MS / 1000,
    message: "Đăng ký thành công. Vui lòng nhập mã OTP đã gửi tới email của bạn."
  })
})

export const login = catchAsync(async (req: Request, res: Response) => {
  const { email, password, rememberMe } = req.body as LoginDTO
  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.login(email, password, userAgent, ip, rememberMe ?? null)

  setAuthCookies(res, result)
  return sendSuccess(res, 200, {
    accessToken: result.accessToken,
    user: result.user
  })
})

export const confirmEmailVerification = catchAsync(async (req: Request, res: Response) => {
  const { email, otp } = req.body as VerifyEmailConfirmDTO
  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.confirmEmailVerification(email, otp, userAgent, ip)

  setAuthCookies(res, result)
  return sendSuccess(res, 200, {
    accessToken: result.accessToken,
    user: result.user,
    message: "Xác thực email thành công!"
  })
})

export const resendVerificationEmail = catchAsync(async (req: Request, res: Response) => {
  const { email } = req.body as ResendVerificationDTO

  await authService.resendVerificationEmail(email)

  return sendSuccess(res, 200, {
    otpExpiresIn: EMAIL_OTP_TTL_MS / 1000,
    message: "Nếu email tồn tại và chưa xác thực, mã OTP mới đã được gửi."
  })
})

export const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const { email } = req.body as ForgotPasswordDTO

  await authService.forgotPassword(email)

  return sendSuccess(res, 200, {
    otpExpiresIn: EMAIL_OTP_TTL_MS / 1000,
    message: "Nếu email tồn tại trong hệ thống, chúng tôi đã gửi mã OTP đặt lại mật khẩu."
  })
})

export const verifyResetPasswordOtp = catchAsync(async (req: Request, res: Response) => {
  const { email, otp } = req.body as VerifyResetOtpDTO

  const resetToken = await authService.verifyResetPasswordOtp(email, otp)

  return sendSuccess(res, 200, {
    resetToken,
    resetTokenExpiresIn: RESET_PASSWORD_GRANT_TTL_MS / 1000
  })
})

export const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const { resetToken, password } = req.body as ResetPasswordDTO

  await authService.resetPassword(resetToken, password)

  return sendSuccess(res, 200, {
    message: "Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại."
  })
})

export const googleAuth = catchAsync(async (req: Request, res: Response) => {
  const { idToken, rememberMe } = req.body as GoogleAuthDTO
  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.googleAuth(idToken, userAgent, ip, rememberMe ?? null)

  setAuthCookies(res, result)
  return sendSuccess(res, 200, {
    accessToken: result.accessToken,
    user: result.user
  })
})

export const refresh = catchAsync(async (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken
  if (!refreshToken) {
    throw new ApiError(401, "Refresh token is missing", "MISSING_REFRESH_TOKEN")
  }

  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.refresh(refreshToken, userAgent, ip)

  setAuthCookies(res, result)
  return sendSuccess(res, 200, {
    accessToken: result.accessToken
  })
})

export const logout = catchAsync(async (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken
  await authService.logout(refreshToken)

  clearAuthCookies(res)
  return sendSuccess(res, 200, null)
})

export const logoutAll = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  await authService.logoutAll(userId)

  clearAuthCookies(res)
  return sendSuccess(res, 200, null)
})
