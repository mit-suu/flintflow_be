import { Router } from "express"
import * as specificationController from "./specification.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Specifications
 *   description: Quản lý và sinh tự động tài liệu đặc tả sản phẩm (Product Specification Sections)
 */

/**
 * @swagger
 * /api/v1/specifications/projects/{projectId}:
 *   get:
 *     summary: Lấy danh sách toàn bộ các section đặc tả của dự án
 *     tags: [Specifications]
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
 *         description: Danh sách các sections
 *       401:
 *         description: Chưa xác thực
 */
router.get("/projects/:projectId", authMiddleware, specificationController.getSections)
router.get("/projects/:projectId/progress", authMiddleware, specificationController.getProgress)

/**
 * @swagger
 * /api/v1/specifications/projects/{projectId}/generate:
 *   post:
 *     summary: Sinh đặc tả một section bằng AI dựa trên ngữ cảnh chat
 *     tags: [Specifications]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, chatSessionId]
 *             properties:
 *               type:
 *                 type: string
 *                 example: vision_problem
 *                 description: Loại section cần sinh đặc tả (ví dụ vision_problem, stakeholders, value_proposition, scope_out_of_scope...)
 *               chatSessionId:
 *                 type: string
 *                 example: 60a5e8f498c49e29a8f4c173
 *                 description: ID của cuộc trò chuyện chứa ngữ cảnh làm rõ để AI đúc rút
 *     responses:
 *       200:
 *         description: Section đặc tả được sinh thành công
 *       400:
 *         description: Thiếu thông tin đầu vào
 *       401:
 *         description: Chưa xác thực
 */
router.post("/projects/:projectId/generate", authMiddleware, specificationController.generateSection)
router.post("/projects/:projectId/generate-phase", authMiddleware, specificationController.generatePhase)

/**
 * @swagger
 * /api/v1/specifications/projects/{projectId}/{type}:
 *   put:
 *     summary: Cập nhật thủ công nội dung đặc tả của một section
 *     tags: [Specifications]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của dự án
 *       - in: path
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *         description: Loại section cần cập nhật (ví dụ vision_problem)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *                 example: "Nội dung đặc tả mới dạng markdown..."
 *               status:
 *                 type: string
 *                 example: edited_manually
 *     responses:
 *       200:
 *         description: Section đặc tả đã được cập nhật thành công
 *       400:
 *         description: Nội dung trống
 *       401:
 *         description: Chưa xác thực
 */
router.put("/projects/:projectId/:type", authMiddleware, specificationController.updateSection)
router.put("/projects/:projectId/:type/accept", authMiddleware, specificationController.acceptSection)
router.post("/projects/:projectId/:type/accept", authMiddleware, specificationController.acceptSection)
router.post("/projects/:projectId/approve-baseline", authMiddleware, specificationController.approveSRSForHandoff)

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
 *       - Specifications
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
 *       - Specifications
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
