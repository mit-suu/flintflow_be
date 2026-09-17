import { Router } from "express"
import * as renderController from "./render.controller.js"
import * as exportController from "./export.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Render
 *   description: S-8.2 Document Assembly — ghép RenderedDocument từ Spine (Phases §6.3–§6.5)
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/assemble:
 *   post:
 *     summary: S-8.2 — ghép bản draft ở spine_version hiện tại, lưu cache
 *     tags: [Render]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [base_version]
 *             properties:
 *               base_version:
 *                 type: integer
 *     responses:
 *       200:
 *         description: "{ spine_version, sections, generated_at }"
 *       404:
 *         description: PROJECT_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT
 */
router.post("/:projectId/assemble", authMiddleware, renderController.assembleController)

/**
 * @swagger
 * /api/v1/projects/{projectId}/document:
 *   get:
 *     summary: Lấy RenderedDocument đã ghép (draft từ cache theo spine_version, baseline từ snapshot)
 *     tags: [Render]
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
 *         description: "`_id` Mongo (= `snapshot_ref`) hoặc mã `BLnnn` mà GET /baselines trả; bỏ trống ⇒ baseline mới nhất"
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: RenderedDocument (render/rendered-document.schema.ts)
 *       404:
 *         description: PROJECT_NOT_FOUND, BASELINE_NOT_FOUND
 *       409:
 *         description: NO_WORKING_DRAFT (chưa gọi POST /assemble lần nào — meta.hint = "S-8.2")
 */
router.get("/:projectId/document", authMiddleware, renderController.getDocumentController)

/**
 * @swagger
 * /api/v1/projects/{projectId}/export/word:
 *   get:
 *     summary: Xuất file Word thật — đọc Spine/Baseline qua assemble.service, không nhận body
 *     tags: [Render]
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
 *         description: "`_id` Mongo (= `snapshot_ref`) hoặc mã `BLnnn` mà GET /baselines trả; bỏ trống ⇒ baseline mới nhất"
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File .docx, tên `<project>-<version>[-draft].docx`. `source=draft` kèm header `X-Assembled-At-Version`, `X-Spine-Version`.
 *       401:
 *         description: Chưa xác thực
 *       404:
 *         description: PROJECT_NOT_FOUND, BASELINE_NOT_FOUND
 *       409:
 *         description: NO_WORKING_DRAFT (chưa assemble — meta.hint = "S-8.2")
 *       422:
 *         description: RENDER_IMAGE_INVALID
 */
// review C1: route thật của endpoint 18 (pipeline-contract.md) — trước đây mount kép ở app.ts
// (renderRoutes + exportRoutes cùng lên /api/v1/projects) vô tình lộ thêm POST /projects/word/preview
// và GET /projects/:projectId/export/word/export/word. Handler vẫn ở export.controller.ts (T05 tạo
// file), chỉ route Express chuyển sang đây — export.route.ts giờ chỉ còn /word/preview (dev, T05).
router.get("/:projectId/export/word", authMiddleware, exportController.exportWord)

export default router
