import { Router } from "express"
import {
  estimateCostHandler,
  executeAiActionHandler,
  retryAiActionHandler
} from "./ai-action.controller.js"
import { authMiddleware } from "../auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * /api/v1/ai-actions/estimate-cost:
 *   post:
 *     summary: Ước tính chi phí Credit cho một AI Action
 *     tags: [AI Actions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [actionType]
 *             properties:
 *               actionType:
 *                 type: string
 *     responses:
 *       200:
 *         description: Trả về số credit yêu cầu
 */
router.post("/estimate-cost", estimateCostHandler)

/**
 * @swagger
 * /api/v1/ai-actions/execute:
 *   post:
 *     summary: Thực thi một AI Action (Tự động kiểm tra credit, prompt, retry và log)
 *     tags: [AI Actions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [actionType, input]
 *             properties:
 *               actionType:
 *                 type: string
 *               input:
 *                 type: object
 *               projectId:
 *                 type: string
 *               provider:
 *                 type: string
 *               model:
 *                 type: string
 *     responses:
 *       200:
 *         description: Kết quả thực thi AI Action
 */
router.post("/execute", authMiddleware, executeAiActionHandler)

/**
 * @swagger
 * /api/v1/ai-actions/retry/{logId}:
 *   post:
 *     summary: Thử lại một AI Action đã thất bại trước đó
 *     tags: [AI Actions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: logId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Kết quả thử lại AI Action
 */
router.post("/retry/:logId", authMiddleware, retryAiActionHandler)

export default router
