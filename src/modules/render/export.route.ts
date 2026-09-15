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

/**
 * @swagger
 * /api/v1/projects/{projectId}/export/word:
 *   get:
 *     summary: Xuất file Word thật (T15) — đọc Spine/Baseline qua assemble.service, không nhận body
 *     tags: [Export]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [draft, baseline]
 *           default: draft
 *       - in: query
 *         name: baseline_id
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File .docx, tên `<project>-<version>[-draft].docx`
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: PROJECT_NOT_FOUND, BASELINE_NOT_FOUND
 *       409:
 *         description: NO_WORKING_DRAFT (chưa assemble — meta.hint = "S-8.2")
 *       422:
 *         description: RENDER_IMAGE_INVALID
 */
router.get("/:projectId/export/word", authMiddleware, exportController.exportWord)

export default router
