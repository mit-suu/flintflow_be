import { Router } from "express"
import * as googleController from "./google.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"
import * as docsAgentController from "./docs-agent/docs-agent.controller.js"
import { requireDocsAgentEnabled } from "./docs-agent/docs-agent.guard.js"

/**
 * Route Google gắn theo dự án, mount ở `/api/v1/projects` (sau `orgGuard`): danh sách Google Doc đã xuất và trợ lý Google
 * Docs. Xuất Google Docs nằm ở `render.route.ts`, nhập ở `import.route.ts`.
 */
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

/**
 * @swagger
 * /api/v1/projects/{projectId}/google-docs/agent/messages/stream:
 *   post:
 *     summary: Trợ lý Google Docs — một tin nhắn (2 credit). Agent đọc qua tool MCP; tool ghi chỉ tạo đề xuất chờ duyệt
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [documentId, message]
 *             properties:
 *               documentId: { type: string }
 *               message: { type: string, maxLength: 4000 }
 *               history:
 *                 type: array
 *                 maxItems: 12
 *                 items: { type: object, properties: { role: { type: string, enum: [user, assistant] }, content: { type: string } } }
 *     responses:
 *       200:
 *         description: "text/event-stream: tool-call { name, args }, text-delta { delta }, finish { data: { reply, pending_actions, document_title }, tokensUsed, cost }, error { error, code }"
 *       401: { description: GOOGLE_RECONNECT_REQUIRED }
 *       403: { description: ORG_ROLE_FORBIDDEN (Viewer), GOOGLE_FILE_FORBIDDEN }
 *       404: { description: PROJECT_NOT_FOUND, GOOGLE_FILE_NOT_FOUND }
 *       503: { description: "GOOGLE_INTEGRATION_DISABLED | GOOGLE_DOCS_AGENT_DISABLED" }
 * /api/v1/projects/{projectId}/google-docs/agent/actions/{actionId}/apply:
 *   post:
 *     summary: Áp dụng một đề xuất vào Google Doc (miễn phí)
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: "{ applied: true, actionId, documentId, revisionId }" }
 *       404: { description: PENDING_ACTION_NOT_FOUND (đã áp dụng / bỏ qua / quá 1 giờ / của người khác) }
 *       409: { description: GOOGLE_DOC_CHANGED — tài liệu đã đổi so với lúc xem trước }
 * /api/v1/projects/{projectId}/google-docs/agent/actions/{actionId}/dismiss:
 *   post:
 *     summary: Bỏ qua một đề xuất (miễn phí)
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: "{ dismissed: true, actionId }" }
 *       404: { description: PENDING_ACTION_NOT_FOUND }
 */
const agentRoles = requireRole("lead", "analyst")
router.post("/:projectId/google-docs/agent/messages/stream", authMiddleware, requireDocsAgentEnabled, agentRoles, docsAgentController.streamMessage)
router.post("/:projectId/google-docs/agent/actions/:actionId/apply", authMiddleware, requireDocsAgentEnabled, agentRoles, docsAgentController.applyAction)
router.post("/:projectId/google-docs/agent/actions/:actionId/dismiss", authMiddleware, requireDocsAgentEnabled, agentRoles, docsAgentController.dismissAction)

export default router
