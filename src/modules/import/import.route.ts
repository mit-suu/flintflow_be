import { Router } from "express"
import * as importController from "./import.controller.js"
import * as orgLibrary from "./org-library.controller.js"
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
 *           enum: [uploaded, preflight_rejected, awaiting_latest_confirm, parsing, mapping_review, extracting, fields_review, baselining, incomplete, drafting, checking, gap_review, delivered, change_requested]
 *           description: "FLF-343: file mới đi uploaded → parsing → extracting (chờ Bắt đầu) → baselining → checking → gap_review; awaiting_latest_confirm / mapping_review / fields_review chỉ còn ở bản ghi cũ"
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
 *       Nhận loại file theo magic bytes. FLF-343: tách block + khớp profile ngay (mapping độ tin thấp tự nhận) ⇒ `extracting`
 *       chưa chạy — màn báo credit một lần (`GET /import` → `credit_estimate`). File không stamp ⇒ `confirmed_latest_at = null`,
 *       câu hỏi "bản mới nhất" trả lời cùng `POST /import/extract` (`confirm_latest`).
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
 *               intent: { type: string, enum: [fixed, free], description: "FLF-335 bước 1.2: file theo một mẫu cố định hay cấu trúc tự do; thiếu ⇒ free; dự án mới có mẫu bắt buộc luôn fixed" }
 *     responses:
 *       201:
 *         description: "`{ import: ImportedDocument }` — `import.intent` là ý định đã ghi"
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
 *     summary: (Bản ghi cũ) xác nhận file không có stamp là bản mới nhất (nút 1.3) rồi tách block + khớp profile
 *     description: FLF-343 — file mới không dừng ở awaiting_latest_confirm; dùng `confirm_latest` của `POST /import/extract`.
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
 *     summary: (Bản ghi cũ ở mapping_review) xác nhận/sửa mapping heading → section và cột bảng → field (UC-21, nút 1.7)
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
 *     summary: Nút Bắt đầu (FLF-343) — chạy một mạch I-4 ⇒ baseline 0.1 ⇒ kiểm tra (nút 1.8–1.12)
 *     description: |
 *       Chạy nền: trả ngay `{ import (extracting, paused null), sections }`; I-4 xong thì job finalize nối tiếp (base_version do
 *       server tính, Record of Changes đọc từ file) rồi 1.11–1.12; FE poll `GET /import` tới `gap_review` / `incomplete` hoặc có `paused`.
 *       `confirm_latest: true` bắt buộc khi file chưa xác nhận là bản mới nhất (thiếu ⇒ 409 IMPORT_NEEDS_LATEST_CONFIRM, không chạy).
 *       Mapping / field độ tin thấp vào baseline kèm cờ vàng `import_needs_review` ("Cần xem").
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
 *           schema: { type: object, required: [import_id], properties: { import_id: { type: string }, confirm_latest: { type: boolean } } }
 *     responses:
 *       200: { description: "`{ import, sections: [{ section_id, status, fields_total, fields_needing_review, error }] }` — trả ngay, import ở extracting" }
 *       409: { description: "IMPORT_INVALID_STATE, IMPORT_NEEDS_LATEST_CONFIRM" }
 */
router.post("/:id/import/extract", authMiddleware, importController.extract)

/**
 * @swagger
 * /api/v1/projects/{id}/import/fields:
 *   patch:
 *     summary: (Bản ghi cũ ở fields_review) xác nhận / sửa / bỏ field độ tin thấp (UC-22, nút 1.9)
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
 *     summary: Ghi Spine + tạo version 0.1 + baseline imported, rồi AI check + code rule (nút 1.10–1.12) — FLF-343 chạy tự động sau I-4; gọi tay cho `incomplete` (Hoàn thiện)
 *     description: |
 *       Chạy nền (SRS lớn mất vài phút — không giữ request qua reverse proxy): kiểm trạng thái + `base_version` ngay
 *       (409 như cũ), rồi trả ngay `{ import (baselining, paused null), baseline: null, flags: null }`; FE poll `GET /import`
 *       tới `gap_review` hoặc có `paused`. Gọi lại khi đang chạy ⇒ trả trạng thái hiện tại. Job lỗi giữa chừng ⇒ hoàn về
 *       trước finalize, `baselining` + `paused: { reason: resume_later }`; gọi `/import/resume` để chạy lại.
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
 *       200: { description: "`{ import, doc_version: \"0.1\", baseline: null, spine_version, flags: null }` — trả ngay, import ở baselining (job nền)" }
 *       409: { description: IMPORT_INVALID_STATE, SPINE_VERSION_CONFLICT }
 */
router.post("/:id/import/finalize", authMiddleware, importController.finalize)

/**
 * @swagger
 * /api/v1/projects/{id}/import/continue:
 *   post:
 *     summary: Chế độ 3 (mẫu bắt buộc còn thiếu mục) — viết phần còn thiếu với FlintFlow (Luồng 2) thay vì Hoàn thiện
 *     description: |
 *       Chỉ từ `incomplete` khi `target_structure.resolved_mode = 3`. Mở lại bước Brief (B-1…S-1), giữ bước sở hữu mục thiếu
 *       `pending`, chuyển dự án sang luồng tạo mới (`mode = fpt`, `import_state = drafting`). Bản in vẫn theo mẫu; ký
 *       baseline 1.0 ⇒ dự án về mode 1 (FLF-318).
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [import_id, base_version], properties: { import_id: { type: string }, base_version: { type: integer } } }
 *     responses:
 *       200: { description: "`{ project_mode: \"fpt\", import_state: \"drafting\", current_step, spine_version }`" }
 *       409: { description: IMPORT_INVALID_STATE (không phải chế độ 3 / không ở incomplete), SPINE_VERSION_CONFLICT }
 */
router.post("/:id/import/continue", authMiddleware, importController.continueFlow2)

// FLF-278 trên FLF-335/336 — mẫu / thư viện nội dung của tổ chức, đi qua dự án (contract §FLF-278)
router.post("/:id/import/from-org", authMiddleware, orgLibrary.importFromOrg)
router.post("/:id/import/save-to-org", authMiddleware, orgLibrary.saveToOrg)
router.get("/:id/library-matches", authMiddleware, orgLibrary.libraryMatches)
router.post("/:id/library", authMiddleware, orgLibrary.saveSectionToLibrary)

/**
 * @swagger
 * /api/v1/projects/{id}/import/resume:
 *   post:
 *     summary: Tiếp tục bước AI đang dừng vì hết credit / lỗi AI (UC-61, UC-75)
 *     description: |
 *       Chạy nền, trả ngay: `extracting` ⇒ I-4 từ extract_cursor; `baselining` (job finalize lỗi / mất) ⇒ hoàn phần dở rồi
 *       chạy lại finalize; `checking` ⇒ 1.11–1.12 phần còn thiếu. FE poll `GET /import`.
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
 *       200: { description: "`{ import, sections }` — trả ngay, import giữ trạng thái (paused null)" }
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
 *       200: { description: "JSON: `{ project_id, doc_version, generated_at, totals, layout, sections, unrendered_diagrams, low_confidence_fields }`; docx: file (tải lần đầu khi đang gap_review ⇒ delivered)" }
 *       409: { description: IMPORT_INVALID_STATE (chưa tới gap_review) }
 */
router.get("/:id/gap-report", authMiddleware, importController.gapReport)

/**
 * @swagger
 * /api/v1/projects/{id}/step-plan:
 *   get:
 *     summary: Kế hoạch step theo template của file upload (#32, mode 1 v2)
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "`{ steps: [{ step_id, state: applied|hidden|enabled, section_ids, reason }] }`" }
 *       409: { description: IMPORT_INVALID_STATE (chưa finalize) }
 *   patch:
 *     summary: Bật step ẩn / tắt step đã bật chưa có dữ liệu (#33)
 *     tags: [Import (mode 1)]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [step_id, enabled], properties: { step_id: { type: string }, enabled: { type: boolean } } }
 *     responses:
 *       200: { description: "`{ steps }` sau khi đổi" }
 *       404: { description: STEP_NOT_IN_PLAN }
 *       409: { description: "CORE_STEP_REQUIRED (tắt bước luôn chạy / step đã có dữ liệu), IMPORT_INVALID_STATE" }
 */
router.get("/:id/step-plan", authMiddleware, importController.getStepPlan)
router.patch("/:id/step-plan", authMiddleware, importController.patchStepPlan)

export default router
