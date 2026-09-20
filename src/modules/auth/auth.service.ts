import crypto from "crypto"
import axios from "axios"
import { OAuth2Client } from "google-auth-library"
import { User, IUser } from "../user/user.model.js"
import { AuthToken, TokenType } from "./auth-token.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { signAccessToken, signRefreshToken, hashToken, TokenPayload } from "../../shared/auth/jwt.util.js"
import * as sessionService from "../../shared/auth/session.service.js"
import { sendVerificationOtpEmail, sendPasswordResetOtpEmail } from "../../shared/email/email.service.js"
import { env } from "../../config/env.js"
import { REMEMBER_ME_MAX_AGE_MS, REMEMBER_ME_TTL } from "../../shared/auth/auth-cookie.js"

export interface AuthResult {
  accessToken: string
  refreshToken: string
  /** Chế độ "Ghi nhớ tài khoản" của phiên — controller dựa vào đây để chọn kiểu cookie. */
  rememberMe: boolean | null
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
  rememberMe: boolean | null
}

/** Refresh token + hạn phiên theo chế độ ghi nhớ: tick ⇒ 30 ngày, còn lại ⇒ `REFRESH_TOKEN_EXPIRES`. */
const issueRefreshToken = (payload: TokenPayload, rememberMe: boolean | null) =>
  rememberMe
    ? {
        refreshToken: signRefreshToken(payload, REMEMBER_ME_TTL),
        expiresAt: new Date(Date.now() + REMEMBER_ME_MAX_AGE_MS)
      }
    : { refreshToken: signRefreshToken(payload), expiresAt: getRefreshTokenExpiresAt() }

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

export const EMAIL_OTP_TTL_MS = 2 * 60 * 1000
export const EMAIL_OTP_MAX_ATTEMPTS = 5

// Salt bằng userId: 6 chữ số dễ trùng giữa các user, mà tokenHash là unique.
const hashEmailOtp = (userId: string, otp: string): string => hashToken(`${userId}:${otp}`)

/** Tạo OTP mới cho `type` (mã cũ cùng loại mất hiệu lực), trả mã gốc để gửi email. */
const createEmailOtp = async (user: IUser, type: TokenType): Promise<string> => {
  const userId = user._id.toString()
  await AuthToken.deleteMany({ userId, type })

  const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0")
  await AuthToken.create({
    userId,
    type,
    tokenHash: hashEmailOtp(userId, otp),
    expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MS)
  })
  return otp
}

/**
 * Kiểm tra và tiêu thụ OTP: hết hạn, quá số lần sai, sai mã (tăng đếm) đều ném ApiError.
 * Thành công thì đánh dấu đã dùng — có điều kiện để hai request song song không cùng qua được.
 */
const consumeEmailOtp = async (user: IUser, type: TokenType, otp: string): Promise<void> => {
  const userId = user._id.toString()
  const authToken = await AuthToken.findOne({ userId, type, usedAt: null })

  // TTL index của Mongo có thể đã xoá bản ghi hết hạn, nên "không tìm thấy" cũng là hết hạn.
  if (!authToken || authToken.expiresAt < new Date()) {
    throw new ApiError(400, "Mã OTP đã hết hạn. Vui lòng gửi lại mã mới.", "OTP_EXPIRED")
  }

  if (authToken.attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
    throw new ApiError(400, "Bạn đã nhập sai quá nhiều lần. Vui lòng gửi lại mã mới.", "OTP_TOO_MANY_ATTEMPTS")
  }

  const expected = Buffer.from(authToken.tokenHash, "hex")
  const actual = Buffer.from(hashEmailOtp(userId, otp), "hex")
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    const updated = await AuthToken.findOneAndUpdate(
      { _id: authToken._id },
      { $inc: { attempts: 1 } },
      { returnDocument: "after" }
    )
    const remaining = Math.max(0, EMAIL_OTP_MAX_ATTEMPTS - (updated?.attempts ?? EMAIL_OTP_MAX_ATTEMPTS))
    if (remaining === 0) {
      throw new ApiError(400, "Bạn đã nhập sai quá nhiều lần. Vui lòng gửi lại mã mới.", "OTP_TOO_MANY_ATTEMPTS")
    }
    throw new ApiError(400, `Mã OTP không đúng. Bạn còn ${remaining} lần thử.`, "INVALID_OTP")
  }

  const consumed = await AuthToken.findOneAndUpdate(
    { _id: authToken._id, usedAt: null },
    { usedAt: new Date() }
  )
  if (!consumed) {
    throw new ApiError(400, "Mã OTP đã được sử dụng", "OTP_ALREADY_USED")
  }
}

const issueEmailOtp = async (user: IUser): Promise<void> => {
  const otp = await createEmailOtp(user, "verify_email")
  await sendVerificationOtpEmail(user.email, otp, user.name)
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

  await issueEmailOtp(user)

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
  ip?: string,
  rememberMe: boolean | null = null
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
  const { refreshToken, expiresAt } = issueRefreshToken(tokenPayload, rememberMe)

  await sessionService.createSession(
    user._id.toString(),
    refreshToken,
    expiresAt,
    userAgent,
    ip,
    rememberMe
  )

  return {
    accessToken,
    refreshToken,
    rememberMe: rememberMe,
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
  email: string,
  otp: string,
  userAgent?: string,
  ip?: string
): Promise<AuthResult> => {
  const normalizedEmail = email.toLowerCase().trim()
  const user = await User.findOne({ email: normalizedEmail })
  if (!user || user.authProvider !== "local") {
    throw new ApiError(400, "Mã OTP không hợp lệ", "INVALID_OTP")
  }

  if (user.emailVerified) {
    throw new ApiError(400, "Email đã được xác thực. Vui lòng đăng nhập.", "EMAIL_ALREADY_VERIFIED")
  }

  await consumeEmailOtp(user, "verify_email", otp)

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
  const { refreshToken, expiresAt } = issueRefreshToken(tokenPayload, null)

  await sessionService.createSession(
    user._id.toString(),
    refreshToken,
    expiresAt,
    userAgent,
    ip,
    null
  )

  return {
    accessToken,
    refreshToken,
    rememberMe: null,
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

  await issueEmailOtp(user)
}

export const forgotPassword = async (email: string): Promise<void> => {
  const normalizedEmail = email.toLowerCase().trim()
  const user = await User.findOne({ email: normalizedEmail })
  // Im lặng khi không có tài khoản để chống dò email. Tài khoản Google (chưa có mật khẩu) vẫn nhận OTP:
  // nhập đúng mã là đã chứng minh sở hữu email ⇒ được tạo mật khẩu để đăng nhập bằng email.
  if (!user) {
    return
  }

  const otp = await createEmailOtp(user, "reset_password")
  await sendPasswordResetOtpEmail(user.email, otp, user.name)
}

export const RESET_PASSWORD_GRANT_TTL_MS = 10 * 60 * 1000

/**
 * Bước 1 đặt lại mật khẩu: nhập đúng OTP ⇒ cấp vé dùng một lần (10 phút) cho bước đặt mật khẩu mới.
 * Tách hai bước vì OTP chỉ sống 2 phút, không đủ cho user nghĩ và gõ mật khẩu mới.
 */
export const verifyResetPasswordOtp = async (email: string, otp: string): Promise<string> => {
  const normalizedEmail = email.toLowerCase().trim()
  const user = await User.findOne({ email: normalizedEmail })
  if (!user) {
    throw new ApiError(400, "Mã OTP đã hết hạn. Vui lòng gửi lại mã mới.", "OTP_EXPIRED")
  }

  await consumeEmailOtp(user, "reset_password", otp)

  const userId = user._id.toString()
  await AuthToken.deleteMany({ userId, type: "reset_password_grant" })
  const resetToken = crypto.randomBytes(32).toString("hex")
  await AuthToken.create({
    userId,
    type: "reset_password_grant",
    tokenHash: hashToken(resetToken),
    expiresAt: new Date(Date.now() + RESET_PASSWORD_GRANT_TTL_MS)
  })
  return resetToken
}

/** Bước 2: đặt mật khẩu mới bằng vé từ bước 1. */
export const resetPassword = async (resetToken: string, newPassword: string): Promise<void> => {
  // Tiêu thụ có điều kiện: hai request song song với cùng vé chỉ một cái qua được.
  const grant = await AuthToken.findOneAndUpdate(
    {
      tokenHash: hashToken(resetToken),
      type: "reset_password_grant",
      usedAt: null,
      expiresAt: { $gt: new Date() }
    },
    { usedAt: new Date() }
  )
  if (!grant) {
    throw new ApiError(
      400,
      "Phiên đặt lại mật khẩu đã hết hạn. Vui lòng yêu cầu mã OTP mới.",
      "RESET_SESSION_EXPIRED"
    )
  }

  const user = await User.findById(grant.userId)
  if (!user) {
    throw new ApiError(404, "User không tồn tại", "USER_NOT_FOUND")
  }

  // Update password & save (triggers bcrypt pre-save hook)
  user.password = newPassword
  // Đã nhập đúng OTP gửi qua email ⇒ đã chứng minh sở hữu email
  if (!user.emailVerified) {
    user.emailVerified = true
    user.emailVerifiedAt = new Date()
  }
  await user.save()

  // Security best practice: Revoke ALL active sessions across devices on password change
  await sessionService.revokeAllUserSessions(user._id.toString())
}

export const googleAuth = async (
  token: string,
  userAgent?: string,
  ip?: string,
  rememberMe: boolean | null = null
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
  const { refreshToken, expiresAt } = issueRefreshToken(tokenPayload, rememberMe)

  await sessionService.createSession(
    user._id.toString(),
    refreshToken,
    expiresAt,
    userAgent,
    ip,
    rememberMe
  )

  return {
    accessToken,
    refreshToken,
    rememberMe: rememberMe,
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
  let decoded: { userId: string; email: string; role?: string }
  try {
    const { verifyRefreshToken } = await import("../../shared/auth/jwt.util.js")
    decoded = verifyRefreshToken(oldRefreshToken)
  } catch (error) {
    throw new ApiError(401, "Invalid or expired refresh token", "INVALID_REFRESH_TOKEN")
  }

  let role = decoded.role
  if (!role) {
    const user = await User.findById(decoded.userId).select("role")
    role = user?.role
  }

  const newPayload: TokenPayload = {
    userId: decoded.userId,
    email: decoded.email,
    role
  }

  // Giữ nguyên chế độ "ghi nhớ" của phiên cũ qua mỗi lần xoay vòng
  const rememberMe = await sessionService.findSessionRememberMe(oldRefreshToken)
  const newAccessToken = signAccessToken(newPayload)
  const { refreshToken: newRefreshToken, expiresAt } = issueRefreshToken(newPayload, rememberMe)

  await sessionService.rotateSession(
    oldRefreshToken,
    newRefreshToken,
    expiresAt,
    userAgent,
    ip,
    rememberMe
  )

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    rememberMe
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
