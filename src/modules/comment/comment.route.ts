import { Router } from "express"
import * as commentController from "./comment.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"

const router = Router()

/**
 * Comment ghim vào nội dung SRS (UC-49). Mount dưới `/api/v1/projects` sau `orgGuard`; `POST /comments` và
 * `POST …/replies` nằm trong allowlist của `viewerReadOnly` (Viewer được comment, BR-27 kiểm ở service).
 *
 * @swagger
 * tags:
 *   name: Comments
 *   description: Comment ghim vào section / block của tài liệu SRS (UC-49)
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/comments:
 *   get:
 *     summary: Danh sách comment của project, cũ trước
 *     tags: [Comments]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [open, all], default: open } }
 *     responses:
 *       200: { description: "`Comment[]`" }
 *       404: { description: PROJECT_NOT_FOUND }
 *   post:
 *     summary: Viết comment ghim vào section / block của phiên bản đang đọc (mọi vai trò; Viewer chỉ trên baseline)
 *     tags: [Comments]
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
 *             required: [version, anchor, text]
 *             properties:
 *               version:
 *                 type: object
 *                 required: [source]
 *                 properties:
 *                   source: { type: string, enum: [draft, baseline] }
 *                   baseline_id: { type: string, description: "`BLnnn` hoặc `snapshot_ref`; bỏ trống ⇒ baseline mới nhất" }
 *               anchor:
 *                 type: object
 *                 required: [section_id]
 *                 properties:
 *                   section_id: { type: string, description: "`RenderedSection.id`" }
 *                   block_index: { type: integer, nullable: true, description: "chỉ số trong `section.blocks`; null = cả section" }
 *               text: { type: string, maxLength: 2000 }
 *     responses:
 *       201: { description: "`Comment`" }
 *       400: { description: VALIDATION_ERROR }
 *       403: { description: "COMMENT_VERSION_FORBIDDEN — Viewer comment trên bản nháp" }
 *       404: { description: PROJECT_NOT_FOUND, BASELINE_NOT_FOUND }
 *       422: { description: COMMENT_ANCHOR_NOT_FOUND }
 */
router.get("/:projectId/comments", authMiddleware, commentController.listComments)
router.post("/:projectId/comments", authMiddleware, commentController.createComment)

/**
 * @swagger
 * /api/v1/projects/{projectId}/comments/{commentId}/replies:
 *   post:
 *     summary: Trả lời một comment (mọi vai trò)
 *     tags: [Comments]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: commentId, required: true, schema: { type: string, example: CM-001 } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [text], properties: { text: { type: string, maxLength: 2000 } } }
 *     responses:
 *       201: { description: "`Comment`" }
 *       404: { description: COMMENT_NOT_FOUND }
 */
router.post("/:projectId/comments/:commentId/replies", authMiddleware, commentController.replyComment)

/**
 * @swagger
 * /api/v1/projects/{projectId}/comments/{commentId}/resolve:
 *   post:
 *     summary: Đánh dấu comment đã xử lý, không đổi nội dung (Analyst, Lead)
 *     tags: [Comments]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: commentId, required: true, schema: { type: string, example: CM-001 } }
 *     responses:
 *       200: { description: "`Comment`" }
 *       403: { description: ORG_ROLE_FORBIDDEN }
 *       404: { description: COMMENT_NOT_FOUND }
 *       409: { description: COMMENT_NOT_OPEN }
 */
router.post("/:projectId/comments/:commentId/resolve", authMiddleware, requireRole("lead", "analyst"), commentController.resolveComment)

export default router
