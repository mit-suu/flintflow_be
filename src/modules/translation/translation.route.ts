import { Router } from "express"
import * as translationController from "./translation.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { requireRole } from "../../shared/auth/require-role.middleware.js"

const router = Router()

/**
 * @swagger
 * /api/v1/projects/{projectId}/translations/status:
 *   get:
 *     summary: Số đơn vị chữ SRS chưa dịch sang ngôn ngữ tài liệu + ước tính số lô / credit (không gọi model)
 *     tags: [Translations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: locale
 *         required: false
 *         description: Ngôn ngữ đích (FLF-334 B) — mặc định ngôn ngữ tài liệu của dự án
 *         schema:
 *           type: string
 *           enum: [vi, en]
 *       - in: query
 *         name: baseline_id
 *         required: false
 *         description: "FLF-334 B — đếm trên snapshot baseline này (mode 2, cùng giá trị #18) thay vì Spine hiện tại"
 *         schema:
 *           type: string
 *       - in: query
 *         name: version
 *         required: false
 *         description: "FLF-334 B — đếm trên snapshot baseline của DocVersion này (mode 1, vd 1.0); không dùng cùng baseline_id"
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: "{ locale, source_locale, total, missing, batches, estimated_credits } — ngôn ngữ đích = ngôn ngữ gốc ⇒ total 0"
 *       400:
 *         description: VALIDATION_ERROR (locale lạ; cả baseline_id lẫn version)
 *       404:
 *         description: PROJECT_NOT_FOUND, BASELINE_NOT_FOUND, DOC_VERSION_NOT_FOUND
 *       409:
 *         description: DOCUMENT_LANGUAGE_UNAVAILABLE (dự án mode 1 import thật hỏi ngôn ngữ khác; version không có snapshot baseline)
 */
router.get("/:projectId/translations/status", authMiddleware, translationController.getTranslationStatus)

/**
 * @swagger
 * /api/v1/projects/{projectId}/translations/run:
 *   post:
 *     summary: Dịch theo lô phần còn thiếu (mỗi lô một lượt translate_document, tính credit theo lô) — Spine không đổi
 *     tags: [Translations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               max_batches:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *                 default: 5
 *               locale:
 *                 type: string
 *                 enum: [vi, en]
 *                 description: Ngôn ngữ đích (FLF-334 B) — mặc định ngôn ngữ tài liệu của dự án
 *               baseline_id:
 *                 type: string
 *                 description: FLF-334 B — dịch đơn vị của snapshot baseline này (mode 2) thay vì Spine hiện tại
 *               version:
 *                 type: string
 *                 description: FLF-334 B — dịch đơn vị của snapshot baseline của DocVersion này (mode 1); không dùng cùng baseline_id
 *     responses:
 *       200:
 *         description: "{ translated, remaining, credits_used } — FE gọi lại tới remaining = 0; dừng khi translated = 0 (lô không tiến, tránh trả credit lặp)"
 *       400:
 *         description: VALIDATION_ERROR
 *       402:
 *         description: INSUFFICIENT_CREDIT (ngay lô đầu; giữa chừng thì dừng và trả phần đã dịch)
 *       409:
 *         description: TRANSLATION_RUNNING (một lượt dịch khác của dự án đang chạy) · DOCUMENT_LANGUAGE_UNAVAILABLE (import thật + locale khác; version không có snapshot baseline)
 *       422:
 *         description: PARSE_FAILED / SCHEMA_MISMATCH (mọi lô đã thử đều trả sai định dạng; lô hỏng lẻ thì bỏ qua)
 *       403:
 *         description: ORG_ROLE_FORBIDDEN (Viewer)
 *       404:
 *         description: PROJECT_NOT_FOUND, BASELINE_NOT_FOUND, DOC_VERSION_NOT_FOUND
 */
router.post("/:projectId/translations/run", authMiddleware, requireRole("lead", "analyst"), translationController.runTranslations)

export default router
