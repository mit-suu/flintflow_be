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

export default router
