import { Router } from "express"
import * as flagsController from "./flags.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * /api/v1/projects/{projectId}/flags:
 *   get:
 *     summary: Danh sách cờ đỏ/vàng của dự án
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
 *         name: level
 *         schema:
 *           type: string
 *           enum: [red, yellow]
 *       - in: query
 *         name: open
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *     responses:
 *       200:
 *         description: Flag[]
 *       404:
 *         description: PROJECT_NOT_FOUND
 */
router.get("/:projectId/flags", authMiddleware, flagsController.getFlags)

/**
 * @swagger
 * /api/v1/projects/{projectId}/flags/recompute:
 *   post:
 *     summary: Chạy lại deterministic check (12 luật đỏ + 11 luật vàng) và cập nhật flags[]
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
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               at_baseline:
 *                 type: boolean
 *                 description: Bật các luật gắn S-9 (unconfirmed_assumption, *_at_baseline)
 *     responses:
 *       200:
 *         description: "Flag[]; meta = { checked_at_version, opened[], resolved[], reopened[] }"
 *       409:
 *         description: SPINE_VERSION_CONFLICT
 */
router.post("/:projectId/flags/recompute", authMiddleware, flagsController.recomputeFlags)

/**
 * @swagger
 * /api/v1/projects/{projectId}/flags/{flagId}/waive:
 *   post:
 *     summary: Waive một cờ (lý do ≥ 20 ký tự; cấm array_empty, dead_reference, render_error)
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
 *         name: flagId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 minLength: 20
 *     responses:
 *       200:
 *         description: Flag đã waive
 *       400:
 *         description: VALIDATION_ERROR hoặc FLAG_NOT_WAIVABLE
 *       404:
 *         description: FLAG_NOT_FOUND
 */
router.post("/:projectId/flags/:flagId/waive", authMiddleware, flagsController.waiveFlag)

/**
 * @swagger
 * /api/v1/projects/{projectId}/progress:
 *   get:
 *     summary: Điểm sẵn sàng, tiến độ theo step và status tính của từng section
 *     tags: [Spine]
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
 *         description: "{ readiness, progress, sections[] }"
 */
router.get("/:projectId/progress", authMiddleware, flagsController.getProgress)

export default router
