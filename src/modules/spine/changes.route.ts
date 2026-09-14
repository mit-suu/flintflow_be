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
 *       required: [base_version, ops]
 *       properties:
 *         base_version:
 *           type: integer
 *           description: spine_version đã đọc từ GET /spine
 *         ops:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/SpineOp'
 *         reason:
 *           type: string
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/changes:
 *   post:
 *     summary: Áp một lô op lên Spine (một transaction, kiểm bất biến cuối lô, cascade khi xoá)
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
 *         description: "{ txn, spine_version, changes[], spine }"
 *       400:
 *         description: VALIDATION_ERROR
 *       404:
 *         description: PROJECT_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT — base_version lệch spine_version hiện tại
 *       422:
 *         description: OP_INVALID hoặc INVARIANT_VIOLATION, meta = { violations[], referrers[] }
 *       501:
 *         description: NOT_IMPLEMENTED — body dạng instruction (T17)
 */
router.post("/:projectId/changes", authMiddleware, changesController.applyChanges)

/**
 * @swagger
 * /api/v1/projects/{projectId}/changes/preview:
 *   post:
 *     summary: Xem trước lô op (diff gồm cả op cascade) mà không ghi
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
 *         description: "{ ok, txn, base_version, ops[], changes[], violations[], referrers[] } — ok=false khi lô sẽ bị từ chối"
 *       400:
 *         description: VALIDATION_ERROR
 *       404:
 *         description: PROJECT_NOT_FOUND
 *       409:
 *         description: SPINE_VERSION_CONFLICT
 */
router.post("/:projectId/changes/preview", authMiddleware, changesController.previewChanges)

export default router
