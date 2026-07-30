import { Router } from "express"
import * as userController from "./user.controller.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

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
