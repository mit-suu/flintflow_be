import { Router } from "express"
import * as userController from "./user.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { changePasswordRateLimiter } from "../../shared/middlewares/rate-limit.js"

const router = Router()

/**
 * @swagger
 * /api/v1/users/me:
 *   get:
 *     summary: Get current authenticated user profile
 *     tags:
 *       - Users
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: User profile fetched successfully
 *       401:
 *         description: Unauthorized
 */
router.get("/me", authMiddleware, userController.getMe)

/**
 * @swagger
 * /api/v1/users/me:
 *   patch:
 *     summary: Cập nhật tên hiển thị / mốc onboarding của user hiện tại (UC 1.12)
 *     tags:
 *       - Users
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               onboardedAt:
 *                 type: string
 *                 format: date-time
 *                 nullable: true
 *     responses:
 *       200:
 *         description: User profile sau khi cập nhật
 *       400:
 *         description: VALIDATION_ERROR
 *       401:
 *         description: Unauthorized
 */
router.patch("/me", authMiddleware, userController.updateMe)

/**
 * @swagger
 * /api/v1/users/me/password:
 *   post:
 *     summary: Đổi mật khẩu của user hiện tại (cần mật khẩu hiện tại); thu hồi mọi phiên khác
 *     tags:
 *       - Users
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Đổi mật khẩu thành công
 *       400:
 *         description: VALIDATION_ERROR, INVALID_CURRENT_PASSWORD, SAME_PASSWORD hoặc PASSWORD_NOT_SET
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Rate limit exceeded
 */
router.post("/me/password", authMiddleware, changePasswordRateLimiter, userController.changePassword)

/**
 * @swagger
 * /api/v1/users/{id}:
 *   get:
 *     summary: Get user profile by ID
 *     tags:
 *       - Users
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User profile fetched successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 */
router.get("/:id", authMiddleware, userController.getUserById)

export default router
