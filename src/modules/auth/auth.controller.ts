import { Request, Response } from "express"
import * as authService from "./auth.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { env } from "../../config/env.js"
import {
  LoginDTO,
  RegisterDTO,
  ResendVerificationDTO,
  VerifyEmailConfirmDTO,
  ForgotPasswordDTO,
  ResetPasswordDTO,
  GoogleAuthDTO
} from "./auth.validation.js"
import {
  ACCESS_COOKIE_MAX_AGE_MS,
  REFRESH_COOKIE_MAX_AGE_MS,
  authCookieOptions
} from "../../shared/auth/auth-cookie.js"

const getBaseCookieOptions = () =>
  authCookieOptions({ nodeEnv: env.NODE_ENV, sameSite: env.COOKIE_SAME_SITE, domain: env.COOKIE_DOMAIN })

const getCookieOptions = () => ({ ...getBaseCookieOptions(), maxAge: REFRESH_COOKIE_MAX_AGE_MS })

const getAccessTokenCookieOptions = () => ({ ...getBaseCookieOptions(), maxAge: ACCESS_COOKIE_MAX_AGE_MS })

const clearAuthCookies = (res: Response) => {
  res.clearCookie("refreshToken", getBaseCookieOptions())
  res.clearCookie("accessToken", getBaseCookieOptions())
}

export const register = catchAsync(async (req: Request, res: Response) => {
  const { email, password, name, locale } = req.body as RegisterDTO

  const result = await authService.register(email, password, name, locale)

  return sendSuccess(res, 201, {
    user: result.user,
    message: "Đăng ký thành công. Vui lòng kiểm tra email để xác thực tài khoản."
  })
})

export const login = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body as LoginDTO
  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.login(email, password, userAgent, ip)

  res.cookie("refreshToken", result.refreshToken, getCookieOptions())
  res.cookie("accessToken", result.accessToken, getAccessTokenCookieOptions())
  return sendSuccess(res, 200, {
    accessToken: result.accessToken,
    user: result.user
  })
})

export const confirmEmailVerification = catchAsync(async (req: Request, res: Response) => {
  const { token } = req.body as VerifyEmailConfirmDTO
  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.confirmEmailVerification(token, userAgent, ip)

  res.cookie("refreshToken", result.refreshToken, getCookieOptions())
  res.cookie("accessToken", result.accessToken, getAccessTokenCookieOptions())
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
    message: "Nếu email tồn tại và chưa xác thực, liên kết mới đã được gửi."
  })
})

export const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const { email } = req.body as ForgotPasswordDTO

  await authService.forgotPassword(email)

  return sendSuccess(res, 200, {
    message: "Nếu email tồn tại trong hệ thống, chúng tôi đã gửi liên kết đặt lại mật khẩu."
  })
})

export const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const { token, password } = req.body as ResetPasswordDTO

  await authService.resetPassword(token, password)

  return sendSuccess(res, 200, {
    message: "Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại."
  })
})

export const googleAuth = catchAsync(async (req: Request, res: Response) => {
  const { idToken, locale } = req.body as GoogleAuthDTO
  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.googleAuth(idToken, userAgent, ip, locale)

  res.cookie("refreshToken", result.refreshToken, getCookieOptions())
  res.cookie("accessToken", result.accessToken, getAccessTokenCookieOptions())
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

  res.cookie("refreshToken", result.refreshToken, getCookieOptions())
  res.cookie("accessToken", result.accessToken, getAccessTokenCookieOptions())
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
