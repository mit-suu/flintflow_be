import { User } from "../user/user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { signAccessToken, signRefreshToken, TokenPayload } from "../../shared/auth/jwt.util.js"
import * as sessionService from "../../shared/auth/session.service.js"
import { env } from "../../config/env.js"

export interface AuthResult {
  accessToken: string
  refreshToken: string
  user: {
    id: string
    email: string
  }
}

export interface RefreshResult {
  accessToken: string
  refreshToken: string
}

// Helper to compute expiration Date from config string (e.g. "3d", "7d", "15m")
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

export const register = async (
  email: string,
  password: string,
  userAgent?: string,
  ip?: string
): Promise<AuthResult> => {
  const existingUser = await User.findOne({ email })
  if (existingUser) {
    throw new ApiError(409, "Email already registered", "EMAIL_EXISTS")
  }

  const user = await User.create({ email, password })

  const tokenPayload: TokenPayload = {
    userId: user._id.toString(),
    email: user.email
  }

  const accessToken = signAccessToken(tokenPayload)
  const refreshToken = signRefreshToken(tokenPayload)
  const expiresAt = getRefreshTokenExpiresAt()

  // Save session in DB
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
      email: user.email
    }
  }
}

export const login = async (
  email: string,
  password: string,
  userAgent?: string,
  ip?: string
): Promise<AuthResult> => {
  const user = await User.findOne({ email }).select("+passwordHash")
  if (!user) {
    throw new ApiError(401, "Invalid credentials", "INVALID_CREDENTIALS")
  }

  const isPasswordValid = await user.comparePassword(password)
  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid credentials", "INVALID_CREDENTIALS")
  }

  const tokenPayload: TokenPayload = {
    userId: user._id.toString(),
    email: user.email
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
      email: user.email
    }
  }
}

export const refresh = async (
  oldRefreshToken: string,
  userAgent?: string,
  ip?: string
): Promise<RefreshResult> => {
  const expiresAt = getRefreshTokenExpiresAt()

  // Create preliminary payload for rotation
  // First verify & compute new token payload
  const tempDecoded = sessionService.rotateSession
  // We sign new tokens first
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

  // Rotate in session DB (validates old token, revokes it, and creates new session)
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
