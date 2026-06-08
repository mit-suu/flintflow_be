import { Request, Response } from "express"
import * as authService from "../services/auth.service.js"
import { ApiResponse } from "../utils/response.js"
import { catchAsync } from "../utils/catch-async.js"
import { HTTP_STATUS } from "../constants/http-status.js"
import { LoginDTO } from "../dtos/auth/login.dto.js"
import { RegisterDTO } from "../dtos/auth/register.dto.js"

export const register = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body as RegisterDTO
  const result = await authService.register(email, password)

  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }

  res.cookie("refreshToken", result.accessToken, cookieOptions)
  return ApiResponse.send(res, HTTP_STATUS.CREATED, "User registered successfully", result)
})

export const login = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body as LoginDTO
  const result = await authService.login(email, password)

  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }

  res.cookie("refreshToken", result.accessToken, cookieOptions)
  return ApiResponse.send(res, HTTP_STATUS.OK, "Login successful", result)
})

export const logout = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (userId) {
    await authService.logout(userId)
  }

  res.clearCookie("refreshToken")
  return ApiResponse.send(res, HTTP_STATUS.OK, "Logout successful")
})
