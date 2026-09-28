import { Router } from "express"
import * as changesController from "./changes.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * components:
 *   schemas:
 *     SpineOp:
 *       type: object
 *       required: [op, path]
 *       properties:
 *         op:
 *           type: string
 *           enum: [set, add, remove, renumber]
 *         path:
 *           type: string
 *           description: Path theo khoá, không theo chỉ số — actors[id=A03].name, actors[], screens[id=S07].flow_to[=S08]
 *           example: actors[id=A03].name
 *         value: {}
 *         reason:
 *           type: string
 *     ChangesRequest:
 *       type: object
 *       required: [base_version]
 *       description: Cần đúng một trong hai — ops (lô sẵn) hoặc instruction (câu lệnh tự nhiên).
 *       properties:
 *         base_version:
 *           type: integer
 *           description: spine_version đã đọc từ GET /spine
 *         ops:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/SpineOp'
 *         instruction:
 *           type: string
 *           description: Câu lệnh sửa bằng ngôn ngữ tự nhiên; model dịch sang op qua skill apply-change-op
 *         reason:
 *           type: string
 *           description: Bắt buộc sau khi dự án đã có baseline (UC 6.8) — vào §I Record of Changes
 *         preview_id:
 *           type: string
 *           description: Id bản xem trước user đã xác nhận; có nó thì không gọi lại model
 *         session_id:
 *           type: string
 *           description: Phiên chat nơi user gõ lệnh — model đọc 12 tin cuối phiên, lượt sửa được ghi vào phiên (404 CHAT_SESSION_NOT_FOUND nếu không thuộc project)
 *     Impact:
 *       type: object
 *       properties:
 *         fields:
 *           type: array
 *           items: { type: string }
 *         sections:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id: { type: string }
 *               relation: { type: string, enum: [owner, reads, derived] }
 *         diagrams:
 *           type: array
 *           items: { type: string }
 *         referrers:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               path: { type: string }
 *               id: { type: string }
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/changes:
 *   post:
 *     summary: Áp một lô op lên Spine (một transaction, kiểm bất biến cuối lô, cascade khi xoá)
 *     description: |
 *       Ba nhánh theo phạm vi ảnh hưởng (meta.branch): `silent` áp thẳng · `dependent` nên xem preview
 *       trước · `post_baseline` bắt buộc `reason`. Chạy lại deterministic check sau khi ghi.
 *     tags: [Spine]
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
 *             $ref: '#/components/schemas/ChangesRequest'
 *     responses:
 *       200:
 *         description: "{ txn, spine_version, changes[], spine }; meta = { branch, impact }"
 *       400:
 *         description: VALIDATION_ERROR — body sai, hoặc đã có baseline mà thiếu reason
 *       404:
 *         description: PROJECT_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT · NEEDS_CLARIFICATION (instruction mơ hồ, meta = { clarification })
 *       422:
 *         description: OP_INVALID hoặc INVARIANT_VIOLATION, meta = { violations[], referrers[] }
 */
router.post("/:projectId/changes", authMiddleware, changesController.applyChanges)

/**
 * @swagger
 * /api/v1/projects/{projectId}/changes/preview:
 *   post:
 *     summary: Xem trước lô op (diff gồm cả op cascade) và phạm vi ảnh hưởng mà không ghi
 *     tags: [Spine]
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
 *             $ref: '#/components/schemas/ChangesRequest'
 *     responses:
 *       200:
 *         description: "{ ok, txn, base_version, ops[], changes[], violations[], referrers[], branch, impact, preview_id } — ok=false khi lô sẽ bị từ chối hoặc cần hỏi lại (clarification)"
 *       400:
 *         description: VALIDATION_ERROR
 *       404:
 *         description: PROJECT_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT
 */
router.post("/:projectId/changes/preview", authMiddleware, changesController.previewChanges)

/**
 * @swagger
 * /api/v1/projects/{projectId}/reconcile:
 *   post:
 *     summary: Hoà giải một lượt các section đang stale
 *     description: |
 *       Lượt 1 (không `preview_id`) trả preview diff gộp của mọi section `stale`. Lượt 2 gửi lại
 *       `preview_id` để áp: vẽ lại sơ đồ có source_hash lệch và đặt section về awaiting_reaccept.
 *       Từ chối diff thì không gửi lượt 2 — section vẫn stale.
 *     tags: [Spine]
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
 *             required: [base_version]
 *             properties:
 *               base_version: { type: integer }
 *               preview_id: { type: string }
 *     responses:
 *       200:
 *         description: Preview gộp (chưa có preview_id) hoặc kết quả đã áp (có preview_id)
 *       404:
 *         description: PROJECT_NOT_FOUND · SPINE_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT
 *       422:
 *         description: INVARIANT_VIOLATION · PREVIEW_EXPIRED
 */
router.post("/:projectId/reconcile", authMiddleware, changesController.reconcileChanges)

/**
 * @swagger
 * /api/v1/projects/{projectId}/undo:
 *   post:
 *     summary: Hoàn tác lô thay đổi gần nhất của người dùng
 *     description: |
 *       Revert cả lô `txn` gần nhất bằng `changes[].before`, ghi một txn mới op `revert` — không xoá
 *       lịch sử. Bỏ qua lô render/baseline/recompute cờ và lô đã bị undo.
 *     tags: [Spine]
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
 *             required: [base_version]
 *             properties:
 *               base_version: { type: integer }
 *     responses:
 *       200:
 *         description: "{ txn, spine_version, changes[], spine }"
 *       409:
 *         description: SPINE_VERSION_CONFLICT
 *       422:
 *         description: NOTHING_TO_UNDO · OP_INVALID (revert_conflict) · INVARIANT_VIOLATION
 */
router.post("/:projectId/undo", authMiddleware, changesController.undoLastChange)

/**
 * @swagger
 * /api/v1/projects/{projectId}/assumptions/{assumptionId}:
 *   patch:
 *     summary: Sửa một giả định bằng ngôn ngữ của user — AI dịch sang tiếng Anh, ghi cả hai (FLF-221)
 *     description: |
 *       Một lượt gọi model `translate` (tính credit). Ghi `statement_vi` (câu user gõ) và `statement` (bản EN vào SRS)
 *       trong một transaction. Model lỗi ⇒ không ghi gì.
 *     tags: [Spine]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: assumptionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [statement_vi, base_version]
 *             properties:
 *               statement_vi: { type: string }
 *               base_version: { type: integer }
 *     responses:
 *       200:
 *         description: "{ spine_version, spine }"
 *       400:
 *         description: VALIDATION_ERROR
 *       402:
 *         description: INSUFFICIENT_CREDIT
 *       404:
 *         description: PROJECT_NOT_FOUND · ASSUMPTION_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT · CHANGE_REQUIRES_CR (mode 1 sau v0)
 */
router.patch("/:projectId/assumptions/:assumptionId", authMiddleware, changesController.editAssumption)

/**
 * @swagger
 * /api/v1/projects/{projectId}/changes:
 *   get:
 *     summary: Lịch sử thay đổi theo seq tăng dần
 *     tags: [Spine]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: from
 *         schema:
 *           type: integer
 *       - in: query
 *         name: to
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Change[] theo seq tăng dần (bao gồm hai đầu)
 */
router.get("/:projectId/changes", authMiddleware, changesController.listChanges)

/**
 * @swagger
 * /api/v1/projects/{projectId}/traceability:
 *   get:
 *     summary: Bản đồ liên kết quanh một thực thể (read-only)
 *     tags: [Spine]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: entity
 *         required: true
 *         schema:
 *           type: string
 *           enum: [actor, use_case, function, screen, entity, nfr, feature, business_rule]
 *       - in: query
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: "{ nodes[], edges[] }"
 *       400:
 *         description: VALIDATION_ERROR
 *       404:
 *         description: PROJECT_NOT_FOUND · SPINE_NOT_FOUND
 */
router.get("/:projectId/traceability", authMiddleware, changesController.getTraceability)

export default router
