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

const getCookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  maxAge: 3 * 24 * 60 * 60 * 1000 // 3 days
})

const getAccessTokenCookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  maxAge: 15 * 60 * 1000 // 15 minutes
})

export const register = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body as RegisterDTO

  const result = await authService.register(email, password)

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
  const { idToken } = req.body as GoogleAuthDTO
  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.googleAuth(idToken, userAgent, ip)

  res.cookie("refreshToken", result.refreshToken, getCookieOptions())
  res.cookie("accessToken", result.accessToken, getAccessTokenCookieOptions())
  return sendSuccess(res, 200, {
    accessToken: result.accessToken,
    user: result.user
  })
})

export const refresh = catchAsync(async (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refreshToken
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
  const refreshToken = req.cookies?.refreshToken
  await authService.logout(refreshToken)

  res.clearCookie("refreshToken")
  res.clearCookie("accessToken")
  return sendSuccess(res, 200, null)
})

export const logoutAll = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  await authService.logoutAll(userId)

  res.clearCookie("refreshToken")
  res.clearCookie("accessToken")
  return sendSuccess(res, 200, null)
})
