import { Router } from "express"
import * as pipelineController from "./pipeline.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
// Viewer đọc được tiến độ nhưng không chạy step AI (business-flow.md §2, bảng vai trò)
import { requireRole } from "../../shared/auth/require-role.middleware.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Pipeline
 *   description: Step runner — Intake/Elicit/Draft/Render/Review/Gate/Meter (Phases §3)
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/steps:
 *   get:
 *     summary: Danh sách step (50 + 5×N) kèm trạng thái, calls_used/regenerate_used
 *     tags: [Pipeline]
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
 *         description: "{ current_phase, current_step, steps[] }"
 *       404:
 *         description: PROJECT_NOT_FOUND
 */
router.get("/:projectId/steps", authMiddleware, pipelineController.getSteps)

/**
 * @swagger
 * /api/v1/projects/{projectId}/steps/{stepId}/run:
 *   post:
 *     summary: Chạy step (SSE) — Intake → Elicit → Draft → Render → Review → gate_ready
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [session_id, base_version]
 *             properties:
 *               session_id:
 *                 type: string
 *               base_version:
 *                 type: integer
 *     responses:
 *       200:
 *         description: >
 *           text/event-stream — sự kiện `intake, elicit, answer_needed, draft, ops_applied, render, flags,
 *           gate_ready, error` (đúng `stepEventSchema`, pipeline-contract.md §2)
 *       403:
 *         description: NOT_PIPELINE_SESSION
 *       404:
 *         description: STEP_NOT_FOUND
 *       409:
 *         description: STEP_NOT_RUNNABLE, CALL_LIMIT, SPINE_VERSION_CONFLICT
 */
router.post("/:projectId/steps/:stepId/run", authMiddleware, requireRole("lead", "analyst"), pipelineController.runStepController)

/**
 * @swagger
 * /api/v1/projects/{projectId}/steps/{stepId}/run-state:
 *   get:
 *     summary: Trạng thái lượt chạy step (khôi phục gate/câu hỏi sau khi reload)
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: "runStateResponseSchema hoặc null nếu step chưa chạy lần nào"
 */
router.get("/:projectId/steps/:stepId/run-state", authMiddleware, pipelineController.getStepRunState)

/**
 * @swagger
 * /api/v1/projects/{projectId}/phases/{phase}/run:
 *   post:
 *     summary: Chạy liền các bước của một giai đoạn (SSE) — bước yên lặng tự Accept, dừng khi cần người
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: phase
 *         required: true
 *         schema:
 *           type: string
 *         description: "Id phase (S-6) hoặc đơn vị vòng S-5 (S-5@S03)"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [session_id, base_version]
 *             properties:
 *               session_id:
 *                 type: string
 *               base_version:
 *                 type: integer
 *     responses:
 *       200:
 *         description: >
 *           text/event-stream — như `/steps/:id/run`, thêm `phase_progress`, `auto_accepted` và
 *           `phase_gate` (tóm tắt cả giai đoạn ở cổng chốt cuối)
 *       409:
 *         description: STEP_NOT_RUNNABLE, SPINE_VERSION_CONFLICT
 */
router.post("/:projectId/phases/:phase/run", authMiddleware, requireRole("lead", "analyst"), pipelineController.runPhaseController)

/**
 * @swagger
 * /api/v1/projects/{projectId}/steps/{stepId}/cancel:
 *   post:
 *     summary: Huỷ lượt đang chạy của step (nhả khoá, huỷ request tới model)
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: "{ cancelled, run_id }"
 */
router.post("/:projectId/steps/:stepId/cancel", authMiddleware, requireRole("lead", "analyst"), pipelineController.cancelStepRun)

/**
 * @swagger
 * /api/v1/projects/{projectId}/run-state/active:
 *   get:
 *     summary: Lượt chạy còn sống của dự án (pill "đang chạy nền")
 *     tags: [Pipeline]
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
 *         description: "runStateResponseSchema hoặc null"
 */
router.get("/:projectId/run-state/active", authMiddleware, pipelineController.getActiveRunState)

/**
 * @swagger
 * /api/v1/projects/{projectId}/review-mode:
 *   patch:
 *     summary: FLF-337 — đổi mức duyệt (strict | fast | milestones; balanced cũ = fast), áp từ bước / CR kế tiếp; dùng được cả mode 1
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [review_mode]
 *             properties:
 *               review_mode: { type: string, enum: [strict, balanced, fast, milestones] }
 *     responses:
 *       200:
 *         description: "review_mode + spine_version sau khi ghi"
 */
router.patch("/:projectId/review-mode", authMiddleware, requireRole("lead", "analyst"), pipelineController.setReviewMode)

/**
 * @swagger
 * /api/v1/projects/{projectId}/skip-confirm-sections:
 *   patch:
 *     summary: "FLF-337 — Chấp nhận, không hỏi lại phần này — thêm / gỡ section khỏi danh sách tự qua"
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               add: { type: array, items: { type: string } }
 *               remove: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: "skip_confirm_sections (danh sách sau khi đổi) + spine_version"
 */
router.patch("/:projectId/skip-confirm-sections", authMiddleware, requireRole("lead", "analyst"), pipelineController.patchSkipConfirmSections)

/**
 * @swagger
 * /api/v1/projects/{projectId}/auto-passed:
 *   get:
 *     summary: FLF-337 — thay đổi AI tự qua (bước im, CR tự ghi) kèm số "chưa xem" của người gọi; không chặn gì
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "total, unseen, items[] (id, step_id, label_vi, reason_vi, at, seen)"
 */
router.get("/:projectId/auto-passed", authMiddleware, pipelineController.getAutoPassed)

/**
 * @swagger
 * /api/v1/projects/{projectId}/auto-passed/seen:
 *   post:
 *     summary: FLF-337 — đánh dấu đã xem (ids rỗng ⇒ tất cả)
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: "unseen — số còn chưa xem"
 */
router.post("/:projectId/auto-passed/seen", authMiddleware, pipelineController.markAutoPassedSeenController)

/**
 * @swagger
 * /api/v1/projects/{projectId}/steps/{stepId}/answer:
 *   post:
 *     summary: Trả lời câu hỏi Elicit đang chờ (answer_needed) — luồng SSE của /run tiếp tục
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [session_id, answers]
 *             properties:
 *               session_id:
 *                 type: string
 *               answers:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [question_id, answer]
 *                   properties:
 *                     question_id:
 *                       type: string
 *                     answer:
 *                       oneOf:
 *                         - type: string
 *                         - type: array
 *                           items:
 *                             type: string
 *     responses:
 *       200:
 *         description: "{ accepted: true }"
 *       403:
 *         description: NOT_PIPELINE_SESSION
 *       409:
 *         description: STEP_NOT_RUNNABLE (step không đang chờ trả lời)
 */
router.post("/:projectId/steps/:stepId/answer", authMiddleware, requireRole("lead", "analyst"), pipelineController.answerStep)

/**
 * @swagger
 * /api/v1/projects/{projectId}/steps/{stepId}/gate:
 *   post:
 *     summary: Hành động cổng chốt — accept, revision, regenerate, accept_as_is
 *     tags: [Pipeline]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action, base_version]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [accept, revision, regenerate, accept_as_is]
 *               note:
 *                 type: string
 *                 description: Bắt buộc khi action = revision hoặc accept_as_is
 *               base_version:
 *                 type: integer
 *               function_id:
 *                 type: string
 *                 description: S-5.4 — regenerate ở mức function
 *     responses:
 *       200:
 *         description: "{ step, next_step, spine_version }"
 *       409:
 *         description: STEP_NOT_RUNNABLE, REGENERATE_LIMIT, CALL_LIMIT, NEEDS_USER_INPUT, SPINE_VERSION_CONFLICT
 */
router.post("/:projectId/steps/:stepId/gate", authMiddleware, requireRole("lead", "analyst"), pipelineController.gateStep)

/**
 * @swagger
 * /api/v1/projects/{projectId}/resume:
 *   post:
 *     summary: Mở lại project — revert step in_progress dang dở về pending, trả progress
 *     tags: [Pipeline]
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
 *         description: "{ reverted_step, spine_version, progress }"
 *       404:
 *         description: PROJECT_NOT_FOUND, SPINE_NOT_FOUND
 *       409:
 *         description: STEP_NOT_RUNNABLE (step đang chạy ở request khác), SPINE_VERSION_CONFLICT
 *       422:
 *         description: CHANGE_RANGE_INVALID, OP_INVALID (revert_conflict)
 */
router.post("/:projectId/resume", authMiddleware, requireRole("lead", "analyst"), pipelineController.resumeProjectController)

export default router
