import { Router } from "express"
import * as authController from "./auth.controller.js"
import { validateRequest, loginSchema, registerSchema } from "./auth.validation.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"

const router = Router()

/**
 * @swagger
 * /api/v1/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Validation error
 *       409:
 *         description: Email already registered
 */
router.post("/register", validateRequest(registerSchema), authController.register)

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Login user
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post("/login", validateRequest(loginSchema), authController.login)

/**
 * @swagger
 * /api/v1/auth/refresh:
 *   post:
 *     summary: Refresh access token (Rotation)
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *       401:
 *         description: Invalid, missing, or reused refresh token
 */
router.post("/refresh", authController.refresh)

/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     summary: Logout user (Revoke current session)
 *     tags:
 *       - Auth
 *     responses:
 *       200:
 *         description: Logout successful
 */
router.post("/logout", authController.logout)

/**
 * @swagger
 * /api/v1/auth/logout-all:
 *   post:
 *     summary: Logout from all devices (Revoke all sessions)
 *     tags:
 *       - Auth
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: All sessions revoked successfully
 *       401:
 *         description: Unauthorized
 */
router.post("/logout-all", authMiddleware, authController.logoutAll)

export default router
