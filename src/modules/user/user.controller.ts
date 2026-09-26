import { Request, Response } from "express"
import { z } from "zod"
import * as userService from "./user.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { newPasswordField } from "../../shared/utils/password-field.js"

/** `PATCH /users/me` — chỉ hai field onboarding (UC 1.12), không cho đổi email/role/isActive. */
export const updateMeSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    onboardedAt: z.iso.datetime().nullable().optional()
  })
  .refine((v) => v.name !== undefined || v.onboardedAt !== undefined, { message: "Cần ít nhất name hoặc onboardedAt" })

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1, "Vui lòng nhập mật khẩu hiện tại"),
  newPassword: newPasswordField
})

export const getMe = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const user = await userService.getMe(userId)
  return sendSuccess(res, 200, user)
})

export const changePassword = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const parsed = changePasswordSchema.safeParse(req.body)
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues.map((i) => i.message).join(", "), "VALIDATION_ERROR")
  }

  const { currentPassword, newPassword } = parsed.data
  await userService.changePassword(userId, currentPassword, newPassword, req.cookies?.refreshToken)
  return sendSuccess(res, 200, {
    message: "Đổi mật khẩu thành công. Các thiết bị khác đã được đăng xuất."
  })
})

export const updateMe = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const parsed = updateMeSchema.safeParse(req.body)
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")

  const { name, onboardedAt } = parsed.data
  const user = await userService.updateMe(userId, {
    ...(name === undefined ? {} : { name }),
    ...(onboardedAt === undefined ? {} : { onboardedAt: onboardedAt === null ? null : new Date(onboardedAt) })
  })
  return sendSuccess(res, 200, user)
})

export const getUserById = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  const user = await userService.getUserById(id)
  return sendSuccess(res, 200, user)
})
