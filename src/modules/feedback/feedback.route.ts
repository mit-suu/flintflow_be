import { Router } from "express"
import * as feedbackController from "./feedback.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { validateRequest } from "../project/project.validation.js"
import { CreateFeedbackSchema } from "./feedback.validation.js"

const router = Router()

/**
 * @swagger
 * tags:
 *   name: Feedback
 *   description: Góp ý của người dùng gửi từ app (UC-12)
 */

/**
 * @swagger
 * /api/v1/feedback:
 *   post:
 *     summary: Gửi góp ý (member đã đăng nhập)
 *     tags: [Feedback]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category, message]
 *             properties:
 *               category:
 *                 type: string
 *                 enum: [bug, suggestion, other]
 *               message:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 2000
 *     responses:
 *       201:
 *         description: Đã lưu góp ý
 *       400:
 *         description: VALIDATION_ERROR — category sai hoặc message trống/quá 2000 ký tự
 *       401:
 *         description: Chưa xác thực
 */
router.post("/", authMiddleware, validateRequest(CreateFeedbackSchema), feedbackController.createFeedback)

export default router
