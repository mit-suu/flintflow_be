import { Router } from "express"
import * as adminController from "./admin.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { adminMiddleware } from "../../shared/auth/admin.middleware.js"

const router = Router()

router.use(authMiddleware, adminMiddleware)

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Màn đọc cho admin — danh sách user, số liệu tổng, chi phí AI (Phases §9.2 10.1–10.3)
 */

/**
 * @swagger
 * /api/v1/admin/users:
 *   get:
 *     summary: Danh sách người dùng (phân trang, lọc)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [user, admin] }
 *       - in: query
 *         name: isActive
 *         schema: { type: string, enum: ["true", "false"] }
 *       - in: query
 *         name: q
 *         description: Tìm theo email hoặc tên
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "User[] kèm walletBalance, projectsCount, lastLoginAt; meta gồm page, limit, total, totalPages"
 *       401:
 *         description: Chưa xác thực
 *       403:
 *         description: Không phải admin
 */
router.get("/users", adminController.listUsers)

/**
 * @swagger
 * /api/v1/admin/users/{id}:
 *   get:
 *     summary: Chi tiết người dùng và 20 giao dịch credit gần nhất
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "User + wallet { balance, reserved } + recentTransactions[]"
 *       400:
 *         description: userId không hợp lệ
 *       403:
 *         description: Không phải admin
 *       404:
 *         description: Không tìm thấy người dùng
 */
router.get("/users/:id", adminController.getUser)

/**
 * @swagger
 * /api/v1/admin/metrics:
 *   get:
 *     summary: Số liệu tổng quan hệ thống
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "{ usersTotal, usersNew7d, projectsTotal, projectsActive7d, baselinesTotal, aiCallsToday, aiCalls7d, aiFailRate7d }"
 *       403:
 *         description: Không phải admin
 */
router.get("/metrics", adminController.getMetrics)

/**
 * @swagger
 * /api/v1/admin/ai-cost:
 *   get:
 *     summary: Chi phí AI — token (AiActionLog) và credit đã trừ (CreditTransaction deduct)
 *     description: |
 *       Khoảng [from, to] tính theo ngày Asia/Ho_Chi_Minh, mặc định 30 ngày gần nhất, tối đa 366 ngày.
 *       Credit không lưu provider nên khi groupBy=provider, credit nằm ở dòng `unattributed`.
 *       `estimatedUsd` là ước tính theo bảng giá tạm.
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, example: "2026-09-01" }
 *       - in: query
 *         name: to
 *         schema: { type: string, example: "2026-09-14" }
 *       - in: query
 *         name: groupBy
 *         schema: { type: string, enum: [day, actionType, provider, user], default: day }
 *     responses:
 *       200:
 *         description: "{ from, to, groupBy, currency, rows[{ key, label, calls, failedCalls, promptTokens, completionTokens, credits, estimatedUsd }], totals }"
 *       400:
 *         description: Tham số không hợp lệ
 *       403:
 *         description: Không phải admin
 */
router.get("/ai-cost", adminController.getAiCost)

/**
 * @swagger
 * /api/v1/admin/feedback:
 *   get:
 *     summary: Phản hồi người dùng (stub — model feedback làm ở wave sau)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Luôn là mảng rỗng ở vòng một
 *       403:
 *         description: Không phải admin
 */
router.get("/feedback", adminController.listFeedback)

export default router
