import { Router } from "express"
import * as spineController from "./spine.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Spine
 *   description: Dữ liệu có cấu trúc của SRS (srs-spine.md) — một Spine mỗi dự án
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/spine:
 *   get:
 *     summary: Lấy Spine của dự án (tạo Spine rỗng nếu dự án chưa có)
 *     tags: [Spine]
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
 *         description: Spine của dự án, gồm spine_version dùng làm base_version khi ghi. Lược đồ ở assets/schema/srs-spine.schema.json
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: Không tìm thấy dự án hoặc dự án không thuộc người dùng
 */
router.get("/:projectId/spine", authMiddleware, spineController.getSpine)

export default router
