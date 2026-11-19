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
 *     summary: Google Doc của dự án — bản đã xuất và bản liên kết của mọi thành viên (mới nhất trước)
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
 *         description: "[{ fileId, title, webViewLink, kind: export|linked, source, lang, baselineId, exportedAt, owner { id, name, email }, isMine, folder { id, path, url } | null, stale }]"
 *       404:
 *         description: PROJECT_NOT_FOUND
 *       503:
 *         description: GOOGLE_INTEGRATION_DISABLED
 */
router.get("/:projectId/google-docs/links", authMiddleware, googleController.listProjectLinks)

/**
 * @swagger
 * /api/v1/projects/{projectId}/google-docs/links:
 *   post:
 *     summary: Liên kết một Google Doc (chọn từ Google Picker) vào dự án — xuất không bao giờ ghi đè Doc liên kết
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [fileId], properties: { fileId: { type: string } } }
 *     responses:
 *       200: { description: "Một phần tử như GET links (kind: linked; Doc đã thuộc dự án ⇒ trả bản đang có)" }
 *       400: { description: VALIDATION_ERROR · GOOGLE_DOC_UNSUPPORTED (không phải Google Docs) }
 *       401: { description: GOOGLE_RECONNECT_REQUIRED }
 *       403: { description: ORG_ROLE_FORBIDDEN (Viewer) · GOOGLE_FILE_FORBIDDEN }
 *       404: { description: PROJECT_NOT_FOUND · GOOGLE_FILE_NOT_FOUND }
 * /api/v1/projects/{projectId}/google-docs/links/{fileId}:
 *   delete:
 *     summary: Bỏ Google Doc khỏi dự án (chỉ xoá liên kết, file trên Drive giữ nguyên)
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: "{ removed }" }
 *       403: { description: ORG_ROLE_FORBIDDEN (Viewer) }
 *       404: { description: PROJECT_NOT_FOUND · GOOGLE_DOC_NOT_IN_PROJECT }
 */
const linkRoles = requireRole("lead", "analyst")
router.post("/:projectId/google-docs/links", authMiddleware, linkRoles, googleController.linkProjectDocument)
router.delete("/:projectId/google-docs/links/:fileId", authMiddleware, linkRoles, googleController.unlinkProjectDocument)

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
 *       404: { description: PROJECT_NOT_FOUND, GOOGLE_FILE_NOT_FOUND, GOOGLE_DOC_NOT_IN_PROJECT (documentId không phải Google Doc của dự án) }
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
