import { Router } from "express"
import * as importController from "./import.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Import (mode 1)
 *   description: Upload SRS có sẵn — preflight, tách block, khớp template, trích field, baseline v0, gap report (FLF-171)
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     ImportedDocument:
 *       type: object
 *       properties:
 *         id: { type: string }
 *         project_id: { type: string }
 *         original_name: { type: string }
 *         size: { type: integer }
 *         sha256: { type: string }
 *         status:
 *           type: string
 *           enum: [uploaded, preflight_rejected, awaiting_latest_confirm, parsing, mapping_review, extracting, fields_review, baselining, checking, gap_review, delivered, change_requested]
 *         preflight:
 *           type: object
 *           properties:
 *             status: { type: string, enum: [accepted, rejected] }
 *             issues:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   code: { type: string, enum: [NOT_DOCX, CORRUPT_ZIP, LEGACY_DOC, FILE_ENCRYPTED, FILE_TOO_LARGE, EMPTY_DOCUMENT, FOREIGN_TRACK_CHANGE, FOREIGN_COMMENT] }
 *                   message: { type: string }
 *                   location:
 *                     type: object
 *                     nullable: true
 *                     properties:
 *                       block_ord: { type: integer }
 *                       text: { type: string }
 *         stamp:
 *           type: object
 *           nullable: true
 *           properties:
 *             project_id: { type: string }
 *             version: { type: string, nullable: true }
 *             source: { type: string, nullable: true }
 *         confirmed_latest_at: { type: string, format: date-time, nullable: true }
 *         paused:
 *           type: object
 *           nullable: true
 *           properties:
 *             reason: { type: string, enum: [credits, resume_later] }
 *             at: { type: string, format: date-time }
 *         extract_cursor: { type: string, nullable: true }
 *         created_at: { type: string, format: date-time }
 *         updated_at: { type: string, format: date-time }
 *
 * /api/v1/projects/{id}/import:
 *   post:
 *     summary: Upload SRS .docx và chạy preflight (UC-20, nút 1.1–1.2)
 *     description: |
 *       Nhận loại file theo magic bytes. File không có stamp ⇒ `awaiting_latest_confirm` (gọi confirm-latest);
 *       stamp đúng project ⇒ tách block + khớp profile ngay (`mapping_review` hoặc `extracting`).
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: "`{ import: ImportedDocument }`"
 *       400: { description: Thiếu file / VALIDATION_ERROR }
 *       409: { description: PROJECT_MODE_MISMATCH, IMPORT_INVALID_STATE (đã có baseline ⇒ dùng /reupload) }
 *       422: { description: "IMPORT_FILE_REJECTED (`meta: { import_id, issues }`), IMPORT_STAMP_FOREIGN_PROJECT (`meta: { stamp }`)" }
 *   get:
 *     summary: Trạng thái import, template profile, tiến độ trích field (UC-19)
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "`{ import, profile, extraction: { sections, review_fields }, blocks_count }`" }
 *       409: { description: PROJECT_MODE_MISMATCH }
 */
router.post("/:id/import", authMiddleware, importController.receiveDocx, importController.uploadImport)
router.get("/:id/import", authMiddleware, importController.getImport)

/**
 * @swagger
 * /api/v1/projects/{id}/import/confirm-latest:
 *   post:
 *     summary: Xác nhận file không có stamp là bản mới nhất (nút 1.3) rồi tách block + khớp profile
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [import_id]
 *             properties:
 *               import_id: { type: string }
 *     responses:
 *       200: { description: "`{ import }` ở `mapping_review` hoặc `extracting`" }
 *       404: { description: IMPORT_NOT_FOUND }
 *       409: { description: IMPORT_INVALID_STATE }
 */
router.post("/:id/import/confirm-latest", authMiddleware, importController.confirmLatest)

/**
 * @swagger
 * /api/v1/projects/{id}/import/mapping:
 *   patch:
 *     summary: Xác nhận/sửa mapping heading → section và cột bảng → field (UC-21, nút 1.7)
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [import_id]
 *             properties:
 *               import_id: { type: string }
 *               headings:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     block_id: { type: string, example: B0012 }
 *                     section_id: { type: string, example: "fixed:2.1", description: "Section registry, group:<số>, feature:@<block>, function:@<block> hoặc unmapped" }
 *               tables:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     block_id: { type: string }
 *                     column_index: { type: integer }
 *                     field_path: { type: string, nullable: true, example: "use_cases[].id" }
 *               confirm_all: { type: boolean, description: "true ⇒ xác nhận mọi mục còn lại theo gợi ý và chuyển extracting" }
 *     responses:
 *       200: { description: "`{ import }` — `extracting` khi không còn mục độ tin thấp chưa xác nhận" }
 *       409: { description: IMPORT_INVALID_STATE, IMPORT_NEEDS_LATEST_CONFIRM }
 */
router.patch("/:id/import/mapping", authMiddleware, importController.patchMapping)

/**
 * @swagger
 * /api/v1/projects/{id}/reupload:
 *   post:
 *     summary: Upload lại file sau baseline, so theo block với version mới nhất (UC-24, nút 1.4) — không tạo version
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: "`{ id, original_name, against_version, created_at, summary: { added, removed, modified, moved }, blocks: [{ block_id, change, before?, after? }] }`"
 *       409: { description: IMPORT_INVALID_STATE (chưa có baseline) }
 *       422: { description: IMPORT_FILE_REJECTED, IMPORT_STAMP_FOREIGN_PROJECT }
 */
router.post("/:id/reupload", authMiddleware, importController.receiveDocx, importController.reupload)

/**
 * @swagger
 * /api/v1/projects/{id}/import/extract:
 *   post:
 *     summary: Trích field Spine từ tài liệu (I-4, nút 1.8) — chạy hoặc chạy tiếp từ extract_cursor
 *     description: |
 *       Chạy nền: trả ngay `{ import (extracting, paused null), sections }`; FE poll `GET /import` tới khi rời `extracting` hoặc có `paused`.
 *       Bảng khớp đủ cột trích tất định (không tốn credit); phần chữ còn lại gọi AI theo section (step_id `I-4:<section>`).
 *       Hết credit ⇒ `paused: { reason: credits }`; AI lỗi sau 2 lần retry ⇒ `paused: { reason: resume_later }`.
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [import_id], properties: { import_id: { type: string } } }
 *     responses:
 *       200: { description: "`{ import, sections: [{ section_id, status, fields_total, fields_needing_review, error }] }` — trả ngay, import ở extracting" }
 *       409: { description: IMPORT_INVALID_STATE }
 */
router.post("/:id/import/extract", authMiddleware, importController.extract)

/**
 * @swagger
 * /api/v1/projects/{id}/import/fields:
 *   patch:
 *     summary: Xác nhận / sửa / bỏ field độ tin thấp (UC-22, nút 1.9)
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [import_id]
 *             properties:
 *               import_id: { type: string }
 *               fields:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     section_id: { type: string }
 *                     path: { type: string, example: "actors[id=A01].kind" }
 *                     confirmed: { type: boolean, description: "false ⇒ bỏ field" }
 *                     edited_value: {}
 *               confirm_all: { type: boolean }
 *     responses:
 *       200: { description: "`{ import }` — baselining khi không còn field chưa xác nhận" }
 *       409: { description: IMPORT_INVALID_STATE }
 */
router.patch("/:id/import/fields", authMiddleware, importController.patchFields)

/**
 * @swagger
 * /api/v1/projects/{id}/import/finalize:
 *   post:
 *     summary: Ghi Spine + tạo version 0.0 + baseline imported, rồi AI check + code rule (nút 1.10–1.12)
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [import_id, base_version]
 *             properties:
 *               import_id: { type: string }
 *               base_version: { type: integer }
 *     responses:
 *       200: { description: "`{ import, doc_version: \"0.0\", baseline, spine_version, flags: { red, yellow } }` — import ở gap_review, hoặc checking + paused" }
 *       409: { description: IMPORT_INVALID_STATE, SPINE_VERSION_CONFLICT }
 */
router.post("/:id/import/finalize", authMiddleware, importController.finalize)

/**
 * @swagger
 * /api/v1/projects/{id}/import/resume:
 *   post:
 *     summary: Tiếp tục bước AI đang dừng vì hết credit / lỗi AI (UC-61, UC-75)
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [import_id], properties: { import_id: { type: string } } }
 *     responses:
 *       200: { description: "`{ import, sections }`" }
 *       409: { description: IMPORT_INVALID_STATE }
 */
router.post("/:id/import/resume", authMiddleware, importController.resume)

/**
 * @swagger
 * /api/v1/projects/{id}/gap-report:
 *   get:
 *     summary: Gap report (UC-23, nút 1.13) — JSON hoặc file .docx
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: format, schema: { type: string, enum: [json, docx], default: json } }
 *     responses:
 *       200: { description: "JSON: `{ project_id, doc_version, generated_at, totals, sections, missing_sections, unmapped_headings, low_confidence_fields }`; docx: file (tải lần đầu khi đang gap_review ⇒ delivered)" }
 *       409: { description: IMPORT_INVALID_STATE (chưa tới gap_review) }
 */
router.get("/:id/gap-report", authMiddleware, importController.gapReport)

export default router
