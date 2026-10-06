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
 * /api/v1/admin/users/{id}/status:
 *   patch:
 *     summary: Khoá (UC-66) hoặc mở khoá (UC-67) tài khoản; khoá thì thu hồi mọi phiên của tài khoản
 *     tags: [Admin]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isActive, reason]
 *             properties:
 *               isActive: { type: boolean }
 *               reason:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 500
 *                 description: Bắt buộc cả khi khoá lẫn mở khoá (UC-60, UC-61)
 *     responses:
 *       200: { description: "{ _id, isActive, suspendedAt, suspendReason, reactivatedAt, reactivateReason }" }
 *       409: { description: "USER_ALREADY_SUSPENDED / USER_ALREADY_ACTIVE — tài khoản đã ở trạng thái đó" }
 *       400: { description: VALIDATION_ERROR hoặc CANNOT_SUSPEND_SELF }
 *       404: { description: USER_NOT_FOUND }
 */
router.patch("/users/:id/status", adminController.setUserStatus)

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
/**
 * @swagger
 * /api/v1/admin/orgs:
 *   get:
 *     summary: Danh sách tổ chức kèm gói, số dư ví, số thành viên, số dự án (UC-90)
 *     tags: [Admin]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: plan
 *         schema: { type: string, enum: [free, pro] }
 *       - in: query
 *         name: q
 *         description: Tìm theo tên tổ chức hoặc email người tạo
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "Org[] { id, name, owner, plan, planLabel, wallet, membersCount, projectsCount, createdAt }; meta gồm page, limit, total, totalPages"
 *       400: { description: VALIDATION_ERROR }
 *       403: { description: Không phải admin }
 */
router.get("/orgs", adminController.listOrgs)

/**
 * @swagger
 * /api/v1/admin/orgs/{orgId}/credits:
 *   patch:
 *     summary: Cộng hoặc trừ credit trong ví của một tổ chức, bắt buộc kèm lý do (UC-68)
 *     tags: [Admin]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: orgId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, reason]
 *             properties:
 *               amount:
 *                 type: integer
 *                 description: "Dương = cộng, âm = trừ; 0 không hợp lệ"
 *               reason:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 500
 *     responses:
 *       200: { description: Số dư sau điều chỉnh }
 *       404: { description: ORG_NOT_FOUND }
 *       409: { description: INSUFFICIENT_CREDIT — số dư khả dụng không đủ để trừ }
 */
router.patch("/orgs/:orgId/credits", adminController.adjustOrgCredits)

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
 *     summary: Góp ý người dùng (mới nhất trước, kèm email/tên người gửi)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách góp ý, meta.total là tổng số
 *       403:
 *         description: Không phải admin
 */
router.get("/feedback", adminController.listFeedback)

export default router
