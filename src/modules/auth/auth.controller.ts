import { Request, Response } from "express"
import * as authService from "./auth.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { env } from "../../config/env.js"
import { LoginDTO, RegisterDTO } from "./auth.validation.js"

const getCookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  maxAge: 3 * 24 * 60 * 60 * 1000 // 3 days
})

export const register = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body as RegisterDTO
  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.register(email, password, userAgent, ip)

  res.cookie("refreshToken", result.refreshToken, getCookieOptions())
  return sendSuccess(res, 201, {
    accessToken: result.accessToken,
    user: result.user
  })
})

export const login = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body as LoginDTO
  const userAgent = req.headers["user-agent"]
  const ip = req.ip

  const result = await authService.login(email, password, userAgent, ip)

  res.cookie("refreshToken", result.refreshToken, getCookieOptions())
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
  return sendSuccess(res, 200, {
    accessToken: result.accessToken
  })
})

export const logout = catchAsync(async (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refreshToken
  await authService.logout(refreshToken)

  res.clearCookie("refreshToken")
  return sendSuccess(res, 200, null)
})

export const logoutAll = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  await authService.logoutAll(userId)

  res.clearCookie("refreshToken")
  return sendSuccess(res, 200, null)
})
