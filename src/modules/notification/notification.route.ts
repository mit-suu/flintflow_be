import { Router } from "express"
import * as notificationController from "./notification.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: Thông báo in-app của người dùng
 */

/**
 * @swagger
 * /api/v1/notifications:
 *   get:
 *     summary: Lấy danh sách thông báo của người dùng hiện tại (mới nhất trước)
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: unread
 *         schema:
 *           type: string
 *           enum: ["1", "true"]
 *         description: Chỉ lấy thông báo chưa đọc
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Danh sách thông báo; meta gồm page, limit, total, totalPages, unreadCount
 *       401:
 *         description: Chưa xác thực
 */
router.get("/", authMiddleware, notificationController.getNotifications)

/**
 * @swagger
 * /api/v1/notifications/unread-count:
 *   get:
 *     summary: Đếm số thông báo chưa đọc
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "{ count: number }"
 *       401:
 *         description: Chưa xác thực
 */
router.get("/unread-count", authMiddleware, notificationController.getUnreadCount)

/**
 * @swagger
 * /api/v1/notifications/read-all:
 *   patch:
 *     summary: Đánh dấu tất cả thông báo là đã đọc
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "{ updated: number }"
 *       401:
 *         description: Chưa xác thực
 */
router.patch("/read-all", authMiddleware, notificationController.markAllNotificationsRead)

/**
 * @swagger
 * /api/v1/notifications/{id}/read:
 *   patch:
 *     summary: Đánh dấu một thông báo là đã đọc
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Thông báo sau khi cập nhật
 *       400:
 *         description: ID không hợp lệ
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy thông báo (hoặc không thuộc người dùng)
 */
router.patch("/:id/read", authMiddleware, notificationController.markNotificationRead)

export default router
