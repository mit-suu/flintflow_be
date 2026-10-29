import { Router } from "express"
import * as versionController from "./doc-version.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"

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
 *       - { in: query, name: from, required: true, schema: { type: string, example: "0.1" } }
 *       - { in: query, name: to, required: true, schema: { type: string, example: "0.2" } }
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
 *     description: "`auto` — release ⇒ bản sạch; draft ⇒ Track Changes + watermark DRAFT. Tên (FLF-334) `<tên>_v2.0.docx` · `<tên>_v1.0+CR-014_DRAFT.docx` · `<tên>_v0_DRAFT.docx`; stamp thêm `flintflow_base_version`, `flintflow_latest_cr`, `flintflow_kind`. `tracked` — bản có Track Changes của CR (mode 1 v3: file riêng `tracked_file_ref`; version không có ⇒ bản render). `original` — file người dùng upload (chỉ bản 0.1 / 0.0; version khác ⇒ 404), tên `…_original.docx`. `lang` khác ngôn ngữ tài liệu (FLF-334 B, chỉ version có snapshot baseline của dự án chuyển từ mode 2) ⇒ dựng lại theo `lang`, hậu tố ngôn ngữ cuối tên: `<tên>_v2.0_VI.docx`."
 *     tags: [Versions (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *       - { in: path, name: v, required: true, schema: { type: string } }
 *       - { in: query, name: variant, schema: { type: string, enum: [auto, tracked, original], default: auto } }
 *       - { in: query, name: lang, description: "FLF-334 B — ngôn ngữ của file (mặc định ngôn ngữ tài liệu)", schema: { type: string, enum: [vi, en] } }
 *     responses:
 *       200: { description: "File .docx — tên `<tên>_v2.0[_EN|_VI].docx`" }
 *       400: { description: "VALIDATION_ERROR (`lang` lạ; `variant` tracked/original + `lang` khác)" }
 *       404: { description: DOC_VERSION_NOT_FOUND }
 *       409: { description: TRANSLATION_INCOMPLETE (meta locale/missing/total) · DOCUMENT_LANGUAGE_UNAVAILABLE }
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
 *       403: { description: "ORG_ROLE_FORBIDDEN — chỉ Lead release" }
 *       409: { description: SPINE_VERSION_CONFLICT }
 *       422: { description: "RELEASE_RED_FLAGS_OPEN (`meta.flags`)" }
 */
router.get("/:projectId/versions", authMiddleware, versionController.list)
router.get("/:projectId/versions/compare", authMiddleware, versionController.compare)
router.get("/:projectId/versions/:v/blocks", authMiddleware, versionController.blocks)
router.get("/:projectId/versions/:v/download", authMiddleware, versionController.download)
// Release = khoá baseline mới (UC-45 / BPMN 5.3): chỉ Lead
router.post("/:projectId/release", authMiddleware, requireRole("lead"), versionController.releaseVersion)

/**
 * @swagger
 * /api/v1/projects/{projectId}/review-package:
 *   get:
 *     summary: Gói duyệt (FLF-330, C-7) — mọi CR đã ghi kể từ lần phát hành trước, trạng thái chờ Lead, nhãn bản nháp
 *     tags: [Version (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: "`reviewPackageSchema`"
 */
router.get("/:projectId/review-package", authMiddleware, versionController.getReviewPackage)

/**
 * @swagger
 * /api/v1/projects/{projectId}/review-package/submit:
 *   post:
 *     summary: BA gửi Lead duyệt cả gói (cờ đỏ = 0) — bản nháp khoá tới khi Lead duyệt / yêu cầu sửa
 *     tags: [Version (mode 1)]
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
 *       200:
 *         description: "`reviewPackageSchema` (status pending)"
 *       409:
 *         description: PACKAGE_ALREADY_SUBMITTED, PACKAGE_EMPTY, SPINE_VERSION_CONFLICT
 *       422:
 *         description: RELEASE_RED_FLAGS_OPEN (meta.flags[])
 */
router.post("/:projectId/review-package/submit", authMiddleware, requireRole("lead", "analyst"), versionController.submitReviewPackage)

/**
 * @swagger
 * /api/v1/projects/{projectId}/review-package/request-changes:
 *   post:
 *     summary: Lead yêu cầu sửa gói kèm lý do — mở khoá bản nháp, BA sửa / hoàn tác bằng CR mới rồi gửi lại
 *     tags: [Version (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: projectId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [base_version, reason], properties: { base_version: { type: integer }, reason: { type: string, minLength: 10 } } }
 *     responses:
 *       200:
 *         description: "`reviewPackageSchema` (status changes_requested)"
 *       422:
 *         description: NO_PENDING_SUBMISSION
 */
router.post("/:projectId/review-package/request-changes", authMiddleware, requireRole("lead"), versionController.requestPackageChanges)

export default router
