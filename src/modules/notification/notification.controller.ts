import { Request, Response } from "express"
import * as notificationService from "./notification.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"

const requireUserId = (req: Request): string => {
  const userId = req.user?.userId
  if (!userId) {
    throw new ApiError(401, "User not authenticated", "UNAUTHORIZED")
  }
  return userId
}

const parsePositiveInt = (value: unknown, fallback: number): number => {
  const n = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const getNotifications = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const unread = req.query.unread
  const result = await notificationService.listNotifications(userId, {
    unreadOnly: unread === "1" || unread === "true",
    page: parsePositiveInt(req.query.page, 1),
    limit: parsePositiveInt(req.query.limit, 20)
  })
  return sendSuccess(res, 200, result.items, result.meta)
})

export const getUnreadCount = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const count = await notificationService.countUnread(userId)
  return sendSuccess(res, 200, { count })
})

export const markNotificationRead = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const notification = await notificationService.markRead(userId, req.params.id as string)
  return sendSuccess(res, 200, notification)
})

export const markAllNotificationsRead = catchAsync(async (req: Request, res: Response) => {
  const userId = requireUserId(req)
  const updated = await notificationService.markAllRead(userId)
  return sendSuccess(res, 200, { updated })
})
