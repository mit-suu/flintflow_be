import mongoose from "mongoose"
import { Notification, INotification, NotificationType } from "./notification.model.js"
import { User } from "../user/user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { env } from "../../config/env.js"
import { sendApprovalEmail } from "../../shared/email/email.service.js"
import { publishRealtime, userKey } from "../../shared/realtime/project-events.js"

export interface NotificationPayload {
  type: NotificationType
  title: string
  body: string
  link?: string
  meta?: Record<string, unknown>
  /**
   * Org mà thông báo thuộc về (task-26). Bỏ trống = thông báo cấp nền tảng. Một người ở nhiều org nên
   * thông báo phải lọc được theo org đang mở.
   */
  organizationId?: string
}

export interface ListNotificationsOptions {
  unreadOnly?: boolean
  page?: number
  limit?: number
  /** Org đang mở. null/bỏ trống ⇒ chỉ thấy thông báo cấp nền tảng (tài khoản chưa chọn org). */
  organizationId?: string | null
}

/**
 * task-26: một người ở nhiều org không được thấy lẫn thông báo của org khác. Thông báo cấp nền tảng
 * (`organizationId: null`, vd chào mừng, admin) luôn hiện vì nó không thuộc org nào.
 */
export const scopeToOrg = (userId: string, organizationId?: string | null): Record<string, unknown> => ({
  userId,
  ...(organizationId
    ? { $or: [{ organizationId }, { organizationId: null }] }
    : { organizationId: null })
})

/** UC-89: thông báo việc duyệt (gửi / quyết định baseline và gói thay đổi) được gửi kèm email. */
export const APPROVAL_EMAIL_TYPES: ReadonlySet<string> = new Set([
  "baseline_submitted",
  "baseline_approved",
  "baseline_rejected",
  "review_package_submitted",
  "review_package_changes_requested",
  "review_package_released"
])

/** Link trong thông báo là đường dẫn tương đối của FE ⇒ ghép với APP_URL thành link mở được từ email. */
const absoluteLink = (link?: string): string => {
  const base = env.APP_URL.replace(/\/+$/, "")
  if (!link) return base
  if (/^https?:\/\//i.test(link)) return link
  return `${base}${link.startsWith("/") ? "" : "/"}${link}`
}

/**
 * Gửi email việc duyệt nếu người nhận chưa tắt (`approvalEmails !== false`: tài khoản cũ chưa có field coi như bật).
 * Lỗi chỉ log, không làm hỏng thông báo trong app.
 */
const emailApproval = async (userId: string, payload: NotificationPayload): Promise<void> => {
  try {
    const user = await User.findById(userId).select("email name approvalEmails isActive").lean()
    if (!user?.email || user.approvalEmails === false || user.isActive === false) return
    await sendApprovalEmail(user.email, {
      ...(user.name ? { name: user.name } : {}),
      title: payload.title,
      body: payload.body,
      url: absoluteLink(payload.link)
    })
  } catch (error) {
    console.error(`[Notification] approval email failed for user ${userId} (${payload.type}):`, error)
  }
}

/**
 * Notification là side effect: lỗi ghi không được làm hỏng luồng chính
 * (thanh toán, trừ credit). Lỗi được log và trả về null. Thông báo việc duyệt kèm email (không chờ gửi).
 */
export const notify = async (
  userId: string,
  payload: NotificationPayload
): Promise<INotification | null> => {
  if (APPROVAL_EMAIL_TYPES.has(payload.type)) void emailApproval(userId, payload)
  try {
    const created = await Notification.create({
      userId: new mongoose.Types.ObjectId(userId),
      organizationId: payload.organizationId ? new mongoose.Types.ObjectId(payload.organizationId) : null,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      link: payload.link ?? null,
      meta: payload.meta ?? null
    })
    // FLF-487: chuông workspace của người nhận tải lại ngay thay vì chờ poll 60s
    publishRealtime(userKey(userId), {
      type: "notification_created",
      notification_id: String(created._id),
      organization_id: payload.organizationId ?? null,
      at: new Date().toISOString()
    })
    return created
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

export const countUnread = async (userId: string, organizationId?: string | null): Promise<number> => {
  return Notification.countDocuments({ ...scopeToOrg(userId, organizationId), readAt: null })
}

export const listNotifications = async (
  userId: string,
  { unreadOnly = false, page = 1, limit = 20, organizationId = null }: ListNotificationsOptions = {}
) => {
  const filter: Record<string, unknown> = scopeToOrg(userId, organizationId)
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
    countUnread(userId, organizationId)
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

export const markAllRead = async (userId: string, organizationId?: string | null): Promise<number> => {
  const result = await Notification.updateMany(
    { ...scopeToOrg(userId, organizationId), readAt: null },
    { $set: { readAt: new Date() } }
  )
  return result.modifiedCount
}
