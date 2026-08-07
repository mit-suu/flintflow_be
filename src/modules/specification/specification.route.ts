import { Router } from "express"
import * as specificationController from "./specification.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * /api/v1/specifications/{projectId}/generate-priority:
 *   post:
 *     summary: "UC34 - Xếp hạng tính năng theo mức ưu tiên (MoSCoW)"
 *     description: >
 *       Đọc danh sách Functional Requirements từ DB, gọi AI để phân loại
 *       theo MoSCoW (Must-have, Should-have, Could-have, Won't-have),
 *       cập nhật lại dữ liệu vào Section và tạo SectionVersion mới.
 *       Yêu cầu UC31 đã được chạy trước.
 *     tags:
 *       - Specification
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của project
 *     responses:
 *       200:
 *         description: Danh sách tính năng đã được xếp hạng ưu tiên thành công
 *       400:
 *         description: Chưa có danh sách yêu cầu chức năng (UC31 chưa chạy)
 *       401:
 *         description: Unauthorized
 *       402:
 *         description: Không đủ credit
 *       500:
 *         description: Lỗi AI hoặc lỗi hệ thống
 */
router.post(
  "/:projectId/generate-priority",
  authMiddleware,
  specificationController.generatePriorityRanking
)

/**
 * @swagger
 * /api/v1/specifications/{projectId}/generate-scope:
 *   post:
 *     summary: "UC35 - Sinh scope và out-of-scope"
 *     description: >
 *       Đọc danh sách Functional Requirements đã được xếp hạng MoSCoW,
 *       tách thành In-Scope (Must/Should/Could) và Out-of-Scope (Won't-have),
 *       gọi AI sinh Markdown cho Scope section, lưu vào DB.
 *       Yêu cầu UC34 đã được chạy trước (tất cả FR phải có priority).
 *     tags:
 *       - Specification
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của project
 *     responses:
 *       200:
 *         description: Scope & Out-of-Scope Markdown đã được sinh thành công
 *       400:
 *         description: Chưa xếp hạng tính năng (UC34 chưa chạy) hoặc chưa có FR
 *       401:
 *         description: Unauthorized
 *       402:
 *         description: Không đủ credit
 *       500:
 *         description: Lỗi AI hoặc lỗi hệ thống
 */
router.post(
  "/:projectId/generate-scope",
  authMiddleware,
  specificationController.generateScopeOutOfScope
)

export default router
