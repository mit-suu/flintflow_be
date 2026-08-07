import crypto from "crypto"
import axios from "axios"
import { OAuth2Client } from "google-auth-library"
import { User, IUser } from "../user/user.model.js"
import { AuthToken, TokenType } from "./auth-token.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { signAccessToken, signRefreshToken, hashToken, TokenPayload } from "../../shared/auth/jwt.util.js"
import * as sessionService from "../../shared/auth/session.service.js"
import { sendVerificationEmail, sendPasswordResetEmail } from "../../shared/email/email.service.js"
import { env } from "../../config/env.js"

export interface AuthResult {
  accessToken: string
  refreshToken: string
  user: {
    id: string
    email: string
    emailVerified: boolean
    name?: string
    role?: string
  }
}

export interface RegisterResult {
  user: {
    id: string
    email: string
    emailVerified: boolean
  }
}

export interface RefreshResult {
  accessToken: string
  refreshToken: string
}

const getRefreshTokenExpiresAt = (): Date => {
  const expiresStr = env.REFRESH_TOKEN_EXPIRES
  let durationMs = 3 * 24 * 60 * 60 * 1000 // 3 days default

  if (expiresStr.endsWith("d")) {
    const days = parseInt(expiresStr.replace("d", ""), 10)
    if (!isNaN(days)) durationMs = days * 24 * 60 * 60 * 1000
  } else if (expiresStr.endsWith("h")) {
    const hours = parseInt(expiresStr.replace("h", ""), 10)
    if (!isNaN(hours)) durationMs = hours * 60 * 60 * 1000
  }

  return new Date(Date.now() + durationMs)
}

const generateAuthToken = async (userId: string, type: TokenType, durationMs: number): Promise<string> => {
  // Revoke previous unused tokens of same type for this user
  await AuthToken.deleteMany({ userId, type, usedAt: null })

  const rawToken = crypto.randomBytes(32).toString("hex")
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + durationMs)

  await AuthToken.create({
    userId,
    type,
    tokenHash,
    expiresAt
  })

  return rawToken
}

export const register = async (
  email: string,
  password: string,
  name?: string
): Promise<RegisterResult> => {
  const normalizedEmail = email.toLowerCase().trim()
  const existingUser = await User.findOne({ email: normalizedEmail })
  if (existingUser) {
    throw new ApiError(409, "Email already registered", "EMAIL_EXISTS")
  }

  const user = await User.create({
    email: normalizedEmail,
    password,
    name: name?.trim() || undefined,
    emailVerified: false
  })

  // Generate 24h verification token & send email
  const verifyToken = await generateAuthToken(user._id.toString(), "verify_email", 24 * 60 * 60 * 1000)
  await sendVerificationEmail(user.email, verifyToken, user.name)

  return {
    user: {
      id: user._id.toString(),
      email: user.email,
      emailVerified: user.emailVerified
    }
  }
}

export const login = async (
  email: string,
  password: string,
  userAgent?: string,
  ip?: string
): Promise<AuthResult> => {
  const normalizedEmail = email.toLowerCase().trim()
  const user = await User.findOne({ email: normalizedEmail }).select("+passwordHash")
  if (!user || !user.passwordHash) {
    throw new ApiError(401, "Invalid credentials", "INVALID_CREDENTIALS")
  }

  const isPasswordValid = await user.comparePassword(password)
  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid credentials", "INVALID_CREDENTIALS")
  }

  if (!user.emailVerified) {
    throw new ApiError(403, "Email chưa được xác thực. Vui lòng kiểm tra email của bạn.", "EMAIL_NOT_VERIFIED")
  }

  const tokenPayload: TokenPayload = {
    userId: user._id.toString(),
    email: user.email,
    role: user.role
  }

  const accessToken = signAccessToken(tokenPayload)
  const refreshToken = signRefreshToken(tokenPayload)
  const expiresAt = getRefreshTokenExpiresAt()

  await sessionService.createSession(
    user._id.toString(),
    refreshToken,
    expiresAt,
    userAgent,
    ip
  )

  return {
    accessToken,
    refreshToken,
    user: {
      id: user._id.toString(),
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      role: user.role
    }
  }
}

export const confirmEmailVerification = async (
  rawToken: string,
  userAgent?: string,
  ip?: string
): Promise<AuthResult> => {
  const tokenHash = hashToken(rawToken)
  const authToken = await AuthToken.findOne({ tokenHash, type: "verify_email" })

  if (!authToken) {
    throw new ApiError(400, "Link xác thực không hợp lệ hoặc đã dùng", "INVALID_TOKEN")
  }

  if (authToken.usedAt) {
    throw new ApiError(400, "Link xác thực đã được sử dụng trước đó", "TOKEN_ALREADY_USED")
  }

  if (authToken.expiresAt < new Date()) {
    throw new ApiError(400, "Link xác thực đã hết hạn (24h). Vui lòng yêu cầu gửi lại email mới.", "TOKEN_EXPIRED")
  }

  authToken.usedAt = new Date()
  await authToken.save()

  const user = await User.findById(authToken.userId)
  if (!user) {
    throw new ApiError(404, "User không tồn tại", "USER_NOT_FOUND")
  }

  user.emailVerified = true
  user.emailVerifiedAt = new Date()
  await user.save()

  // Issue session & auto-login after email verification
  const tokenPayload: TokenPayload = {
    userId: user._id.toString(),
    email: user.email,
    role: user.role
  }

  const accessToken = signAccessToken(tokenPayload)
  const refreshToken = signRefreshToken(tokenPayload)
  const expiresAt = getRefreshTokenExpiresAt()

  await sessionService.createSession(
    user._id.toString(),
    refreshToken,
    expiresAt,
    userAgent,
    ip
  )

  return {
    accessToken,
    refreshToken,
    user: {
      id: user._id.toString(),
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      role: user.role
    }
  }
}

export const resendVerificationEmail = async (email: string): Promise<void> => {
  const normalizedEmail = email.toLowerCase().trim()
  const user = await User.findOne({ email: normalizedEmail })
  // Silent return if user not found or already verified to prevent enumeration
  if (!user || user.emailVerified || user.authProvider !== "local") {
    return
  }

  const rawToken = await generateAuthToken(user._id.toString(), "verify_email", 24 * 60 * 60 * 1000)
  await sendVerificationEmail(user.email, rawToken, user.name)
}

export const forgotPassword = async (email: string): Promise<void> => {
  const normalizedEmail = email.toLowerCase().trim()
  const user = await User.findOne({ email: normalizedEmail })
  if (!user || user.authProvider !== "local") {
    return
  }

  // Generate 15-minute password reset token
  const rawToken = await generateAuthToken(user._id.toString(), "reset_password", 15 * 60 * 1000)
  await sendPasswordResetEmail(user.email, rawToken, user.name)
}

export const resetPassword = async (rawToken: string, newPassword: string): Promise<void> => {
  const tokenHash = hashToken(rawToken)
  const authToken = await AuthToken.findOne({ tokenHash, type: "reset_password" })

  if (!authToken) {
    throw new ApiError(400, "Link đặt lại mật khẩu không hợp lệ hoặc đã dùng", "INVALID_TOKEN")
  }

  if (authToken.usedAt) {
    throw new ApiError(400, "Link đặt lại mật khẩu đã được sử dụng trước đó", "TOKEN_ALREADY_USED")
  }

  if (authToken.expiresAt < new Date()) {
    throw new ApiError(400, "Link đặt lại mật khẩu đã hết hạn (15 phút). Vui lòng yêu cầu lại.", "TOKEN_EXPIRED")
  }

  const user = await User.findById(authToken.userId)
  if (!user) {
    throw new ApiError(404, "User không tồn tại", "USER_NOT_FOUND")
  }

  // Update password & save (triggers bcrypt pre-save hook)
  user.password = newPassword
  await user.save()

  authToken.usedAt = new Date()
  await authToken.save()

  // Security best practice: Revoke ALL active sessions across devices on password change
  await sessionService.revokeAllUserSessions(user._id.toString())
}

export const googleAuth = async (
  token: string,
  userAgent?: string,
  ip?: string
): Promise<AuthResult> => {
  const client = new OAuth2Client(env.GOOGLE_CLIENT_ID || undefined)

  let payload: { sub: string; email: string; name?: string } | null = null

  // 1. Try verifyIdToken (JWT ID Token)
  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: env.GOOGLE_CLIENT_ID || undefined
    })
    const p = ticket.getPayload()
    if (p && p.email && p.sub) {
      payload = { sub: p.sub, email: p.email, name: p.name }
    }
  } catch (_) {
    // 2. Fallback: Try fetching Google UserInfo using Access Token
    try {
      const userInfoRes = await axios.get("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      })
      if (userInfoRes.data && userInfoRes.data.email && userInfoRes.data.sub) {
        payload = {
          sub: userInfoRes.data.sub,
          email: userInfoRes.data.email,
          name: userInfoRes.data.name
        }
      }
    } catch (_) {
      throw new ApiError(401, "Google Token không hợp lệ", "INVALID_GOOGLE_TOKEN")
    }
  }

  if (!payload || !payload.email) {
    throw new ApiError(400, "Google Profile không chứa địa chỉ email", "GOOGLE_EMAIL_MISSING")
  }

  const { sub: googleId, name } = payload
  const normalizedEmail = payload.email.toLowerCase().trim()

  // Find user by normalized email OR googleId
  let user = await User.findOne({
    $or: [{ email: normalizedEmail }, { googleId }]
  })

  if (user) {
    // Auto-link Google Account if user already exists
    let updated = false
    if (!user.googleId) {
      user.googleId = googleId
      updated = true
    }
    if (!user.emailVerified) {
      user.emailVerified = true
      user.emailVerifiedAt = new Date()
      updated = true
    }
    if (!user.name && name) {
      user.name = name
      updated = true
    }
    if (updated) {
      await user.save()
    }
  } else {
    // Create new Google user
    user = await User.create({
      email: normalizedEmail,
      name,
      googleId,
      authProvider: "google",
      emailVerified: true,
      emailVerifiedAt: new Date()
    })
  }

  const tokenPayload: TokenPayload = {
    userId: user._id.toString(),
    email: user.email,
    role: user.role
  }

  const accessToken = signAccessToken(tokenPayload)
  const refreshToken = signRefreshToken(tokenPayload)
  const expiresAt = getRefreshTokenExpiresAt()

  await sessionService.createSession(
    user._id.toString(),
    refreshToken,
    expiresAt,
    userAgent,
    ip
  )

  return {
    accessToken,
    refreshToken,
    user: {
      id: user._id.toString(),
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      role: user.role
    }
  }
}

export const refresh = async (
  oldRefreshToken: string,
  userAgent?: string,
  ip?: string
): Promise<RefreshResult> => {
  const expiresAt = getRefreshTokenExpiresAt()

  let decoded: { userId: string; email: string }
  try {
    const { verifyRefreshToken } = await import("../../shared/auth/jwt.util.js")
    decoded = verifyRefreshToken(oldRefreshToken)
  } catch (error) {
    throw new ApiError(401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN")
  }

  const newPayload: TokenPayload = {
    userId: decoded.userId,
    email: decoded.email
  }

  const newAccessToken = signAccessToken(newPayload)
  const newRefreshToken = signRefreshToken(newPayload)

  await sessionService.rotateSession(
    oldRefreshToken,
    newRefreshToken,
    expiresAt,
    userAgent,
    ip
  )

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken
  }
}

export const logout = async (refreshToken?: string): Promise<void> => {
  if (refreshToken) {
    await sessionService.revokeSession(refreshToken)
  }
}

export const logoutAll = async (userId: string): Promise<void> => {
  await sessionService.revokeAllUserSessions(userId)
}
