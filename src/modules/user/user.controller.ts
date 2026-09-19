import { Request, Response } from "express"
import { z } from "zod"
import * as userService from "./user.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { USER_LOCALES } from "./user.model.js"

/**
 * `PATCH /users/me` — field onboarding (UC 1.12) và ngôn ngữ (T25); không cho đổi email/role/isActive.
 */
export const updateMeSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    onboardedAt: z.iso.datetime().nullable().optional(),
    locale: z.enum(USER_LOCALES).optional()
  })
  .refine((v) => v.name !== undefined || v.onboardedAt !== undefined || v.locale !== undefined, {
    message: "Cần ít nhất name, onboardedAt hoặc locale"
  })

export const getMe = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const user = await userService.getUserById(userId)
  return sendSuccess(res, 200, user)
})

export const updateMe = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }

  const parsed = updateMeSchema.safeParse(req.body)
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error), "VALIDATION_ERROR")

  const { name, onboardedAt, locale } = parsed.data
  const user = await userService.updateMe(userId, {
    ...(name === undefined ? {} : { name }),
    ...(locale === undefined ? {} : { locale }),
    ...(onboardedAt === undefined ? {} : { onboardedAt: onboardedAt === null ? null : new Date(onboardedAt) })
  })
  return sendSuccess(res, 200, user)
})

export const getUserById = catchAsync(async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  const user = await userService.getUserById(id)
  return sendSuccess(res, 200, user)
})
