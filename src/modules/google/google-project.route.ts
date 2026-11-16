import { Router } from "express"
import * as googleController from "./google.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

/** Route Google gắn theo dự án, mount ở `/api/v1/projects` (sau `orgGuard`). Xuất Google Docs nằm ở `render.route.ts`. */
const router = Router()

/**
 * @swagger
 * /api/v1/projects/{projectId}/google-docs/links:
 *   get:
 *     summary: Google Doc user hiện tại đã xuất từ dự án (mới nhất trước)
 *     tags: [Google integration]
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
 *         description: "[{ fileId, title, webViewLink, source, lang, baselineId, exportedAt }]"
 *       404:
 *         description: PROJECT_NOT_FOUND
 *       503:
 *         description: GOOGLE_INTEGRATION_DISABLED
 */
router.get("/:projectId/google-docs/links", authMiddleware, googleController.listProjectLinks)

export default router
