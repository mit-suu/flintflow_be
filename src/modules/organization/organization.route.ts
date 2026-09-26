import { Router } from "express"
import * as organizationController from "./organization.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireActiveAccount } from "../../shared/auth/account-guard.middleware.js"
import { orgContextFromParam } from "../../shared/auth/org-context.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"
import { validateRequest } from "../project/project.validation.js"
import {
  ChangeRoleSchema,
  CreateInvitationSchema,
  CreateOrganizationSchema,
  DeleteOrganizationSchema,
  RenameOrganizationSchema
} from "./organization.validation.js"

const router = Router()

/**
 * Thứ tự middleware bám đúng BPMN Flow 10:
 *   authMiddleware (10.1) → requireActiveAccount (10.4) → orgContextFromParam (10.6) → requireRole (10.7)
 * Ở đây orgId đến từ URL vì đây là route QUẢN LÝ org, không phải thao tác trong org đang mở.
 */
const signedIn = [authMiddleware, requireActiveAccount] as const
const inOrg = [...signedIn, orgContextFromParam()] as const

/**
 * @swagger
 * tags:
 *   name: Organizations
 *   description: Tổ chức, thành viên và vai trò (UC-07, UC-10, UC-72, UC-73, UC-74)
 */

/**
 * @swagger
 * /api/v1/orgs:
 *   get:
 *     summary: Danh sách tổ chức của người dùng kèm vai trò từng nơi (UC-10)
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách tổ chức }
 *       401: { description: Chưa xác thực }
 *   post:
 *     summary: Tạo tổ chức, người tạo thành Lead đầu tiên (UC-07)
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, maxLength: 80 }
 *     responses:
 *       201: { description: Đã tạo }
 *       400: { description: VALIDATION_ERROR }
 */
router.get("/", ...signedIn, organizationController.listMyOrganizations)
router.post("/", ...signedIn, validateRequest(CreateOrganizationSchema), organizationController.createOrganization)

/**
 * @swagger
 * /api/v1/orgs/{orgId}:
 *   get:
 *     summary: Một tổ chức kèm vai trò của người gọi và số thành viên
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Thông tin tổ chức }
 *       404: { description: ORG_NOT_FOUND — không tồn tại hoặc không phải thành viên }
 *   patch:
 *     summary: Đổi tên tổ chức (chỉ Lead)
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Đã đổi }
 *       403: { description: ORG_ROLE_FORBIDDEN }
 */
router.get("/:orgId", ...inOrg, organizationController.getOrganization)
router.patch(
  "/:orgId",
  ...inOrg,
  requireRole("lead"),
  validateRequest(RenameOrganizationSchema),
  organizationController.renameOrganization
)

/**
 * @swagger
 * /api/v1/orgs/{orgId}:
 *   delete:
 *     summary: Xoá tổ chức — chỉ khi Lead là thành viên duy nhất; xoá cả dự án, thư mục, ví, gói
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [confirmName]
 *             properties:
 *               confirmName: { type: string, description: "Gõ lại đúng tên tổ chức" }
 *     responses:
 *       200: { description: "{ deleted, projectsDeleted }" }
 *       400: { description: ORG_NAME_MISMATCH }
 *       409: { description: "ORG_HAS_OTHER_MEMBERS, ORG_BUSY (AI đang chạy), ORG_PAYMENT_PENDING" }
 */
router.delete(
  "/:orgId",
  ...inOrg,
  requireRole("lead"),
  validateRequest(DeleteOrganizationSchema),
  organizationController.deleteOrganization
)

/**
 * @swagger
 * /api/v1/orgs/{orgId}/switch:
 *   post:
 *     summary: Chọn tổ chức để làm việc — trả access token mới mang orgId (UC-10)
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: accessToken mới + tổ chức đang mở }
 *       404: { description: ORG_NOT_FOUND }
 */
router.post("/:orgId/switch", ...inOrg, organizationController.switchOrganization)

/**
 * @swagger
 * /api/v1/orgs/{orgId}/members:
 *   get:
 *     summary: Danh sách thành viên kèm vai trò (UC-73)
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách thành viên }
 */
router.get("/:orgId/members", ...inOrg, organizationController.listMembers)

/**
 * @swagger
 * /api/v1/orgs/{orgId}/members/me:
 *   delete:
 *     summary: Rời tổ chức (UC-72). BR-02 chặn Lead cuối cùng.
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Đã rời }
 *       409: { description: LAST_LEAD — phải chỉ định Lead khác trước }
 */
// Phải đứng TRƯỚC "/:orgId/members/:userId", nếu không "me" sẽ bị bắt làm userId.
router.delete("/:orgId/members/me", ...inOrg, organizationController.leaveOrganization)

/**
 * @swagger
 * /api/v1/orgs/{orgId}/members/{userId}:
 *   delete:
 *     summary: Xoá một thành viên khỏi tổ chức (UC-74, chỉ Lead). BR-02 áp dụng.
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Đã xoá }
 *       409: { description: LAST_LEAD }
 */
router.delete("/:orgId/members/:userId", ...inOrg, requireRole("lead"), organizationController.removeMember)

/**
 * @swagger
 * /api/v1/orgs/{orgId}/members/{userId}/role:
 *   patch:
 *     summary: Đổi vai trò một thành viên giữa Lead / Analyst / Viewer (UC-73, chỉ Lead)
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role: { type: string, enum: [lead, analyst, viewer] }
 *     responses:
 *       200: { description: Đã đổi vai trò }
 *       409: { description: LAST_LEAD }
 */
router.patch(
  "/:orgId/members/:userId/role",
  ...inOrg,
  requireRole("lead"),
  validateRequest(ChangeRoleSchema),
  organizationController.changeMemberRole
)

/**
 * @swagger
 * /api/v1/orgs/{orgId}/invitations:
 *   get:
 *     summary: Mã mời của tổ chức, mới nhất trước — không bao giờ trả mã thô (UC-08)
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách lời mời }
 *   post:
 *     summary: Sinh mã mời có hạn kèm vai trò và gửi email (UC-08, chỉ Lead)
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role: { type: string, enum: [analyst, viewer] }
 *               email: { type: string, format: email }
 *     responses:
 *       201: { description: "Đã tạo — mã thô chỉ trả ở lượt này" }
 *       402: { description: PLAN_LIMIT_MEMBERS }
 */
router.get("/:orgId/invitations", ...inOrg, requireRole("lead"), organizationController.listInvitations)
router.post(
  "/:orgId/invitations",
  ...inOrg,
  requireRole("lead"),
  validateRequest(CreateInvitationSchema),
  organizationController.createInvitation
)

/**
 * @swagger
 * /api/v1/orgs/{orgId}/invitations/{invitationId}:
 *   delete:
 *     summary: Thu hồi một mã mời chưa dùng (UC-08, chỉ Lead)
 *     tags: [Organizations]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Đã thu hồi }
 *       409: { description: INVITE_ALREADY_USED — mã đã dùng, hãy xoá thành viên thay vì thu hồi }
 */
router.delete(
  "/:orgId/invitations/:invitationId",
  ...inOrg,
  requireRole("lead"),
  organizationController.revokeInvitation
)

export default router
