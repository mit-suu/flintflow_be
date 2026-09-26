import { Router } from "express"
import * as organizationController from "./organization.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireActiveAccount } from "../../shared/auth/account-guard.middleware.js"

const router = Router()

/**
 * Nhánh "nhập mã mời" của UC-09 / BPMN Flow 8.3–8.5. Tách khỏi `/orgs/:orgId/...` vì người nhập mã CHƯA
 * thuộc org nào — không qua được `orgContextFromParam`, và cũng chưa biết orgId.
 *
 * Vẫn cần đăng nhập: mã mời gắn tài khoản vào org nên phải biết gắn cho ai.
 */
const signedIn = [authMiddleware, requireActiveAccount] as const

/**
 * @swagger
 * tags:
 *   name: Invitations
 *   description: Nhập mã mời để vào tổ chức (UC-09)
 */

/**
 * @swagger
 * /api/v1/invitations/{code}:
 *   get:
 *     summary: Xem trước lời mời trước khi tham gia — tên tổ chức, vai trò, hạn dùng
 *     tags: [Invitations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Thông tin lời mời }
 *       410: { description: INVITE_INVALID — hết hạn, đã dùng hoặc đã thu hồi }
 */
router.get("/:code", ...signedIn, organizationController.previewInvitation)

/**
 * @swagger
 * /api/v1/invitations/{code}/accept:
 *   post:
 *     summary: Nhập mã mời để vào tổ chức với vai trò đã gắn trong mã (UC-09)
 *     tags: [Invitations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "Đã tham gia — kèm access token mới mang orgId" }
 *       409: { description: ALREADY_MEMBER }
 *       410: { description: INVITE_INVALID }
 *       402: { description: PLAN_LIMIT_MEMBERS }
 */
router.post("/:code/accept", ...signedIn, organizationController.acceptInvitation)

export default router
