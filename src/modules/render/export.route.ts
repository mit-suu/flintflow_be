import { Router } from "express"
import * as exportController from "./export.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Export
 *   description: Xuất tài liệu SRS ra file (Word vòng một)
 */

/**
 * @swagger
 * /api/v1/export/word/preview:
 *   post:
 *     summary: Sinh file Word từ RenderedDocument gửi kèm (dùng thử writer, chưa đọc Spine)
 *     tags: [Export]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: RenderedDocument (src/modules/render/rendered-document.types.ts). Mẫu ở fixtures/rendered-document-sample.json
 *     responses:
 *       200:
 *         description: File .docx, tên `<project>-<version>[-draft].docx`
 *         content:
 *           application/vnd.openxmlformats-officedocument.wordprocessingml.document:
 *             schema:
 *               type: string
 *               format: binary
 *       401:
 *         description: Chưa xác thực
 *       422:
 *         description: Body sai RenderedDocument (RENDERED_DOCUMENT_INVALID) hoặc ảnh không phải PNG (RENDER_IMAGE_INVALID)
 */
router.post("/word/preview", authMiddleware, exportController.previewWord)

// review C1: GET /:projectId/export/word (endpoint 18, contract) chuyển sang render.route.ts — route
// đó đã mount ở app.ts dưới /api/v1/projects, mount thêm ở đây (cũng /api/v1/projects, T15 cũ) làm
// lộ trùng cả /projects/word/preview lẫn /projects/:projectId/export/word/export/word. File này giờ
// chỉ còn /word/preview (T05, dev-only — xem README.md).

export default router
