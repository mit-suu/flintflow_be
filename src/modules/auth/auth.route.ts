import { Router } from "express"
import * as authController from "./auth.controller.js"
import {
  validateRequest,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  verifyEmailConfirmSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  googleAuthSchema
} from "./auth.validation.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { authEmailRateLimiter } from "../../shared/middlewares/rate-limit.js"

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
 *         description: User registered successfully. Verification email sent.
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
 *       403:
 *         description: Email not verified
 */
router.post("/login", validateRequest(loginSchema), authController.login)

/**
 * @swagger
 * /api/v1/auth/verify-email/confirm:
 *   post:
 *     summary: Confirm email verification using magic link token
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email verified successfully & session created
 *       400:
 *         description: Invalid or expired token
 */
router.post("/verify-email/confirm", validateRequest(verifyEmailConfirmSchema), authController.confirmEmailVerification)

/**
 * @swagger
 * /api/v1/auth/verify-email/resend:
 *   post:
 *     summary: Resend verification email
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
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Verification email sent if account exists and is unverified
 *       429:
 *         description: Rate limit exceeded
 */
router.post("/verify-email/resend", authEmailRateLimiter, validateRequest(resendVerificationSchema), authController.resendVerificationEmail)

/**
 * @swagger
 * /api/v1/auth/forgot-password:
 *   post:
 *     summary: Request password reset link
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
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Reset email sent if account exists
 *       429:
 *         description: Rate limit exceeded
 */
router.post("/forgot-password", authEmailRateLimiter, validateRequest(forgotPasswordSchema), authController.forgotPassword)

/**
 * @swagger
 * /api/v1/auth/reset-password:
 *   post:
 *     summary: Reset password with token
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - password
 *             properties:
 *               token:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password reset successful. All active sessions revoked.
 *       400:
 *         description: Invalid or expired token
 */
router.post("/reset-password", authEmailRateLimiter, validateRequest(resetPasswordSchema), authController.resetPassword)

/**
 * @swagger
 * /api/v1/auth/google:
 *   post:
 *     summary: Authenticate or register with Google OAuth ID Token
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - idToken
 *             properties:
 *               idToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Google login successful
 *       401:
 *         description: Invalid Google ID token
 */
router.post("/google", validateRequest(googleAuthSchema), authController.googleAuth)

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
