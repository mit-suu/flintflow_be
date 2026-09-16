import mongoose from "mongoose"
import { Notification, INotification, NotificationType } from "./notification.model.js"
import { User } from "../user/user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"

export interface NotificationPayload {
  type: NotificationType
  title: string
  body: string
  link?: string
  meta?: Record<string, unknown>
}

export interface ListNotificationsOptions {
  unreadOnly?: boolean
  page?: number
  limit?: number
}

/**
 * Notification là side effect: lỗi ghi không được làm hỏng luồng chính
 * (thanh toán, trừ credit). Lỗi được log và trả về null.
 */
export const notify = async (
  userId: string,
  payload: NotificationPayload
): Promise<INotification | null> => {
  try {
    return await Notification.create({
      userId: new mongoose.Types.ObjectId(userId),
      type: payload.type,
      title: payload.title,
      body: payload.body,
      link: payload.link ?? null,
      meta: payload.meta ?? null
    })
  } catch (error) {
    console.error(`[Notification] notify failed for user ${userId} (${payload.type}):`, error)
    return null
  }
}

/** Gửi cùng một notification cho mọi admin. Trả về số bản ghi đã tạo. */
export const notifyAdmins = async (payload: NotificationPayload): Promise<number> => {
  try {
    const admins = await User.find({ role: "admin" }, { _id: 1 })
    if (admins.length === 0) return 0

    const docs = admins.map((admin) => ({
      userId: admin._id,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      link: payload.link ?? null,
      meta: payload.meta ?? null
    }))
    const created = await Notification.insertMany(docs)
    return created.length
  } catch (error) {
    console.error(`[Notification] notifyAdmins failed (${payload.type}):`, error)
    return 0
  }
}

export const countUnread = async (userId: string): Promise<number> => {
  return Notification.countDocuments({ userId, readAt: null })
}

export const listNotifications = async (
  userId: string,
  { unreadOnly = false, page = 1, limit = 20 }: ListNotificationsOptions = {}
) => {
  const filter: Record<string, unknown> = { userId }
  if (unreadOnly) filter.readAt = null

  const safeLimit = Math.min(Math.max(limit, 1), 100)
  const safePage = Math.max(page, 1)

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter, null, {
      sort: { createdAt: -1 },
      skip: (safePage - 1) * safeLimit,
      limit: safeLimit
    }),
    Notification.countDocuments(filter),
    countUnread(userId)
  ])

  return {
    items,
    meta: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit),
      unreadCount
    }
  }
}

export const markRead = async (userId: string, notificationId: string): Promise<INotification> => {
  if (!mongoose.isValidObjectId(notificationId)) {
    throw new ApiError(400, "ID thông báo không hợp lệ", "INVALID_NOTIFICATION_ID")
  }

  const existing = await Notification.findOne({ _id: notificationId, userId })
  if (!existing) {
    throw new ApiError(404, "Không tìm thấy thông báo", "NOTIFICATION_NOT_FOUND")
  }

  // Giữ readAt đầu tiên — đánh dấu lại không đổi thời điểm đã đọc
  if (!existing.readAt) {
    existing.readAt = new Date()
    await existing.save()
  }

  return existing
}

export const markAllRead = async (userId: string): Promise<number> => {
  const result = await Notification.updateMany(
    { userId, readAt: null },
    { $set: { readAt: new Date() } }
  )
  return result.modifiedCount
}
