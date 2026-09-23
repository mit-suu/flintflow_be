import { Router } from "express"
import * as authController from "./auth.controller.js"
import {
  validateRequest,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  verifyEmailConfirmSchema,
  forgotPasswordSchema,
  verifyResetOtpSchema,
  resetPasswordSchema,
  googleAuthSchema
} from "./auth.validation.js"
import { authMiddleware } from "../../shared/auth/auth.middleware.js"
import { otpResendRateLimiter, otpVerifyRateLimiter, passwordResetOtpRateLimiter } from "../../shared/middlewares/rate-limit.js"

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
 *         description: User registered successfully. Verification OTP sent by email.
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
 *               rememberMe:
 *                 type: boolean
 *                 description: true ⇒ giữ đăng nhập 30 ngày; false ⇒ cookie phiên (đóng trình duyệt là hết); bỏ trống ⇒ 3 ngày
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
 *     summary: Confirm email verification using the 6-digit OTP (expires after 2 minutes)
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
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *               otp:
 *                 type: string
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Email verified successfully & session created
 *       400:
 *         description: INVALID_OTP, OTP_EXPIRED, OTP_TOO_MANY_ATTEMPTS or EMAIL_ALREADY_VERIFIED
 */
router.post("/verify-email/confirm", otpVerifyRateLimiter, validateRequest(verifyEmailConfirmSchema), authController.confirmEmailVerification)

/**
 * @swagger
 * /api/v1/auth/verify-email/resend:
 *   post:
 *     summary: Resend verification OTP (invalidates the previous one)
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
router.post("/verify-email/resend", otpResendRateLimiter, validateRequest(resendVerificationSchema), authController.resendVerificationEmail)

/**
 * @swagger
 * /api/v1/auth/forgot-password:
 *   post:
 *     summary: Request a 6-digit password reset OTP by email (expires after 2 minutes; also used to resend)
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
router.post("/forgot-password", passwordResetOtpRateLimiter, validateRequest(forgotPasswordSchema), authController.forgotPassword)

/**
 * @swagger
 * /api/v1/auth/reset-password/verify-otp:
 *   post:
 *     summary: Verify the password reset OTP; returns a one-time resetToken (valid 10 minutes)
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
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *               otp:
 *                 type: string
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: OTP correct. Returns resetToken and resetTokenExpiresIn (seconds)
 *       400:
 *         description: INVALID_OTP, OTP_EXPIRED or OTP_TOO_MANY_ATTEMPTS
 */
router.post("/reset-password/verify-otp", otpVerifyRateLimiter, validateRequest(verifyResetOtpSchema), authController.verifyResetPasswordOtp)

/**
 * @swagger
 * /api/v1/auth/reset-password:
 *   post:
 *     summary: Set a new password using the resetToken from /reset-password/verify-otp
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - resetToken
 *               - password
 *             properties:
 *               resetToken:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password reset successful. All active sessions revoked.
 *       400:
 *         description: RESET_SESSION_EXPIRED (token invalid, used or older than 10 minutes)
 */
router.post("/reset-password", otpVerifyRateLimiter, validateRequest(resetPasswordSchema), authController.resetPassword)

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
