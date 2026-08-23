import { Router } from "express"
import * as verificationContextController from "./verification-context.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Verification
 *   description: Quản lý Verification Context và kiểm tra tính sẵn sàng của tài liệu đặc tả (SRS Readiness)
 */

/**
 * @swagger
 * /api/v1/verification/projects/{projectId}:
 *   get:
 *     summary: Lấy thông tin Verification Context và Readiness Score của dự án
 *     tags: [Verification]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *     responses:
 *       200:
 *         description: Trả về VerificationContext
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy dự án
 */
router.get("/projects/:projectId", authMiddleware, verificationContextController.getVerificationContext)
router.get("/:projectId", authMiddleware, verificationContextController.getVerificationContext)

/**
 * @swagger
 * /api/v1/verification/projects/{projectId}/recompute:
 *   post:
 *     summary: Tính toán lại mức độ sẵn sàng cơ bản (Readiness Score) của dự án
 *     tags: [Verification]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *     responses:
 *       200:
 *         description: Trả về kết quả tính toán readiness mới
 *       401:
 *         description: Chưa xác thực
 */
router.post("/projects/:projectId/recompute", authMiddleware, verificationContextController.recomputeReadiness)

export default router
