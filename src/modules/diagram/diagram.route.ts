import { Router } from "express"
import * as diagramController from "./diagram.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Diagram
 *   description: Diagram PlantUML sinh từ Spine (context, usecase, screen_flow, erd, screen_layout)
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/diagrams:
 *   get:
 *     summary: Danh sách diagrams[] kèm cờ stale và đường dẫn file
 *     tags: [Diagram]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: "Diagram[] & { stale: boolean, files: { svg, png } | null }"
 */
router.get("/:projectId/diagrams", authMiddleware, diagramController.listDiagrams)

/**
 * @swagger
 * /api/v1/projects/{projectId}/diagrams/{file}:
 *   get:
 *     summary: File diagram đã render (D01.svg hoặc D01.png)
 *     tags: [Diagram]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: file
 *         required: true
 *         schema:
 *           type: string
 *         example: D01.svg
 *     responses:
 *       200:
 *         description: image/svg+xml hoặc image/png
 *       404:
 *         description: DIAGRAM_NOT_FOUND
 */
router.get("/:projectId/diagrams/:file", authMiddleware, diagramController.getDiagramFile)

/**
 * @swagger
 * /api/v1/projects/{projectId}/diagrams/{kind}/render:
 *   post:
 *     summary: Render thủ công một loại diagram (hoặc all) và ghi diagrams[]
 *     tags: [Diagram]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: kind
 *         required: true
 *         schema:
 *           type: string
 *           enum: [all, context, usecase, screen_flow, erd, screen_layout]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               owner_id:
 *                 type: string
 *                 description: Bắt buộc với screen_layout (id màn)
 *     responses:
 *       200:
 *         description: "{ spine_version, diagrams[], rendered[], removed[] } — .puml lỗi trả render_status=error, không lỗi HTTP"
 *       400:
 *         description: VALIDATION_ERROR
 *       409:
 *         description: SPINE_VERSION_CONFLICT
 */
router.post("/:projectId/diagrams/:kind/render", authMiddleware, diagramController.renderDiagramRoute)

/**
 * @swagger
 * /api/v1/projects/{projectId}/diagrams/render:
 *   post:
 *     summary: Vẽ lại đúng các hình theo danh sách id rồi tính lại cờ (không gỡ / không vẽ hình khác)
 *     tags: [Diagram]
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
 *             required: [diagram_ids]
 *             properties:
 *               diagram_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *               force:
 *                 type: boolean
 *                 description: Mặc định true
 *     responses:
 *       200:
 *         description: "{ spine_version, rendered[], skipped[], flags[] }"
 *       404:
 *         description: DIAGRAM_NOT_FOUND
 */
router.post("/:projectId/diagrams/render", authMiddleware, diagramController.renderDiagramsByIdsRoute)

export default router
