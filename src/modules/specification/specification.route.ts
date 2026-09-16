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
// T19: gỡ `POST /projects/:projectId/approve-baseline` — baseline ký qua `POST /projects/:id/baseline`
// (S-9.5: quét lại tất định, điều kiện cờ đỏ = 0, snapshot).
// T20: gỡ `POST /projects/:projectId/advance-to-generation` — mở sang pha sinh SRS giờ là gate Approve
// của B-2.3 (UC 2.5): accept step đó thì `nextStep` trỏ sang S-1.1 và runner tự đặt `progress`.
// Controller cũ của cả hai xoá cùng module `specification` ở T21.

// T19: gỡ `POST /:projectId/generate-priority` (UC34) và `POST /:projectId/generate-scope` (UC35).
// MoSCoW giờ là S-9.4 — ghi thẳng `functions[].priority` / `nfrs[].priority` bằng op
// (`modules/pipeline/s9/prioritization.ts`), và Won't-have KHÔNG tự đổi `project.release_scope`.
// Controller + service cũ xoá cùng module `specification` ở T21.

export default router
