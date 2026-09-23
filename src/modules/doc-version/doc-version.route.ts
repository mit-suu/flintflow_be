import { Router } from "express"
import * as versionController from "./doc-version.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Versions (mode 1)
 *   description: Version tài liệu 0.0 / 0.x / x.0, xem theo block, so sánh, tải về, release (FLF-171)
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/versions:
 *   get:
 *     summary: Danh sách version tài liệu, mới nhất trước (UC-54)
 *     tags: [Versions (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "`[{ version, kind, based_on, cr_ids, baseline_id, has_clean_file, has_tracked_file, has_original_file, created_by, created_at }]`" }
 * /api/v1/projects/{projectId}/versions/compare:
 *   get:
 *     summary: So sánh hai version theo block (UC-55)
 *     tags: [Versions (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: query, name: from, required: true, schema: { type: string, example: "0.0" } }
 *       - { in: query, name: to, required: true, schema: { type: string, example: "0.1" } }
 *     responses:
 *       200: { description: "`{ from, to, summary: { added, removed, modified, moved }, blocks: [{ block_id, change, before?, after? }] }`" }
 *       404: { description: DOC_VERSION_NOT_FOUND }
 * /api/v1/projects/{projectId}/versions/{v}/blocks:
 *   get:
 *     summary: Block của một version theo thứ tự tài liệu; bản có Track Changes kèm revisions[] (UC-54)
 *     tags: [Versions (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: v, required: true, schema: { type: string, example: "0.1" } }
 *     responses:
 *       200: { description: "`DocBlock[]`" }
 *       404: { description: DOC_VERSION_NOT_FOUND }
 * /api/v1/projects/{projectId}/versions/{v}/download:
 *   get:
 *     summary: Tải file .docx của một version (UC-57)
 *     description: "`auto` — release ⇒ bản sạch; draft ⇒ Track Changes + watermark DRAFT, tên `…_v0.2_DRAFT.docx`. `tracked` — bản có Track Changes của CR (mode 1 v3: file riêng `tracked_file_ref`; version không có ⇒ bản render). `original` — file người dùng upload (chỉ bản 0.0; version khác ⇒ 404)."
 *     tags: [Versions (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: v, required: true, schema: { type: string } }
 *       - { in: query, name: variant, schema: { type: string, enum: [auto, tracked, original], default: auto } }
 *     responses:
 *       200: { description: File .docx }
 *       404: { description: DOC_VERSION_NOT_FOUND }
 * /api/v1/projects/{projectId}/release:
 *   post:
 *     summary: Release — đóng dấu major (1.0, 2.0…), khoá baseline, render bản sạch (Flow 6)
 *     tags: [Versions (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [base_version], properties: { base_version: { type: integer } } }
 *     responses:
 *       201: { description: "`{ version, baseline (type release), cr_ids, spine_version }`" }
 *       409: { description: SPINE_VERSION_CONFLICT }
 *       422: { description: "RELEASE_RED_FLAGS_OPEN (`meta.flags`)" }
 */
router.get("/:projectId/versions", authMiddleware, versionController.list)
router.get("/:projectId/versions/compare", authMiddleware, versionController.compare)
router.get("/:projectId/versions/:v/blocks", authMiddleware, versionController.blocks)
router.get("/:projectId/versions/:v/download", authMiddleware, versionController.download)
router.post("/:projectId/release", authMiddleware, versionController.releaseVersion)

export default router
