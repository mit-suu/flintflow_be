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
 * Lời mời đang chờ của chính người đăng nhập — chấp nhận / từ chối không cần gõ mã (như lời mời collaborator của
 * GitHub). Khai báo TRƯỚC `/:code`: mã mời không bao giờ là "mine" (bảng chữ mã không có chữ I), nhưng thứ tự route
 * vẫn phải đúng để `GET /mine` không rơi vào `previewInvitation`.
 */

/**
 * @swagger
 * /api/v1/invitations/mine:
 *   get:
 *     summary: Lời mời đang chờ của tôi — tên tổ chức, vai trò, người mời, hạn dùng
 *     tags: [Invitations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách lời mời còn hạn, mới nhất trước }
 */
router.get("/mine", ...signedIn, organizationController.listMyInvitations)

/**
 * @swagger
 * /api/v1/invitations/mine/{invitationId}/accept:
 *   post:
 *     summary: Chấp nhận lời mời đang chờ, không cần mã
 *     tags: [Invitations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "Đã tham gia — kèm access token mới mang orgId" }
 *       404: { description: INVITE_NOT_FOUND — không có hoặc không phải lời mời của tôi }
 *       409: { description: ALREADY_MEMBER }
 *       410: { description: INVITE_INVALID }
 *       402: { description: PLAN_LIMIT_MEMBERS }
 */
router.post("/mine/:invitationId/accept", ...signedIn, organizationController.acceptMyInvitation)

/**
 * @swagger
 * /api/v1/invitations/mine/{invitationId}/decline:
 *   post:
 *     summary: Từ chối lời mời đang chờ — Lead được báo và có thể mời lại
 *     tags: [Invitations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: "Lời mời chuyển sang declined" }
 *       404: { description: INVITE_NOT_FOUND }
 *       410: { description: INVITE_INVALID }
 */
router.post("/mine/:invitationId/decline", ...signedIn, organizationController.declineInvitation)

/**
 * @swagger
 * /api/v1/invitations/{code}:
 *   get:
 *     summary: Xem trước lời mời trước khi tham gia — tên tổ chức, vai trò, hạn dùng
 *     tags: [Invitations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Thông tin lời mời }
 *       403: { description: INVITE_EMAIL_MISMATCH — mã dành cho email khác với tài khoản đang đăng nhập }
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
 *       403: { description: INVITE_EMAIL_MISMATCH — chỉ tài khoản đúng email được mời mới nhập được mã }
 *       409: { description: ALREADY_MEMBER }
 *       410: { description: INVITE_INVALID }
 *       402: { description: PLAN_LIMIT_MEMBERS }
 */
router.post("/:code/accept", ...signedIn, organizationController.acceptInvitation)

export default router
