import mongoose from "mongoose"
import { Session, ISession } from "./session.model.js"
import { hashToken, verifyRefreshToken } from "./jwt.util.js"
import { ApiError } from "../utils/api-error.js"

export const createSession = async (
  userId: string,
  refreshToken: string,
  expiresAt: Date,
  userAgent?: string,
  ip?: string,
  rememberMe: boolean | null = null,
  activeOrgId?: string | null
): Promise<ISession> => {
  const tokenHash = hashToken(refreshToken)
  return await Session.create({
    userId: new mongoose.Types.ObjectId(userId),
    tokenHash,
    expiresAt,
    isRevoked: false,
    rememberMe,
    userAgent,
    ip,
    activeOrgId: activeOrgId && mongoose.isValidObjectId(activeOrgId) ? new mongoose.Types.ObjectId(activeOrgId) : null
  })
}

/** Chế độ "ghi nhớ" của phiên ứng với refresh token (không kiểm tra hợp lệ — `rotateSession` lo việc đó). */
export const findSessionRememberMe = async (refreshToken: string): Promise<boolean | null> => {
  const session = await Session.findOne({ tokenHash: hashToken(refreshToken) }).select("rememberMe")
  return session?.rememberMe ?? null
}

export const rotateSession = async (
  oldRefreshToken: string,
  newRefreshToken: string,
  newExpiresAt: Date,
  userAgent?: string,
  ip?: string,
  rememberMe: boolean | null = null,
  activeOrgId?: string | null
): Promise<{ userId: string; email: string; sessionId: string }> => {
  // 1. Verify old token signature & expiration
  let decoded: { userId: string; email: string }
  try {
    decoded = verifyRefreshToken(oldRefreshToken)
  } catch (error) {
    throw new ApiError(401, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", "INVALID_REFRESH_TOKEN")
  }

  const oldHash = hashToken(oldRefreshToken)
  const existingSession = await Session.findOne({ tokenHash: oldHash })

  // 2. Reuse Detection: If session does not exist or was already revoked
  if (!existingSession || existingSession.isRevoked) {
    console.warn(`[REUSE DETECTION] Revoked refresh token reuse attempt for user ${decoded.userId}`)
    // Revoke all sessions for this user as a security precaution
    await Session.updateMany(
      { userId: new mongoose.Types.ObjectId(decoded.userId) },
      { isRevoked: true }
    )
    throw new ApiError(401, "Phiên đăng nhập không còn an toàn nên đã bị đăng xuất trên mọi thiết bị. Vui lòng đăng nhập lại.", "TOKEN_REUSE_DETECTED")
  }

  // Check if token has expired based on DB record
  if (existingSession.expiresAt < new Date()) {
    existingSession.isRevoked = true
    await existingSession.save()
    throw new ApiError(401, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", "EXPIRED_REFRESH_TOKEN")
  }

  // 3. Atomically revoke old session
  const revokedSession = await Session.findOneAndUpdate(
    { _id: existingSession._id, isRevoked: false },
    { isRevoked: true },
    { new: true }
  )

  if (!revokedSession) {
    // Concurrent rotation attempt
    throw new ApiError(401, "Phiên đăng nhập đang được làm mới. Vui lòng thử lại.", "CONCURRENT_REFRESH")
  }

  // 4. Create new session for rotated token
  const newSession = await createSession(decoded.userId, newRefreshToken, newExpiresAt, userAgent, ip, rememberMe, activeOrgId)

  return {
    userId: decoded.userId,
    email: decoded.email,
    sessionId: String(newSession._id)
  }
}

/**
 * Ghi org đang mở vào ĐÚNG phiên đang dùng (task-26, BPMN Flow 9.3). Tìm phiên qua hash của refresh token
 * nên đổi org ở thiết bị này không kéo theo thiết bị khác; lượt refresh sau đó cấp access token mang
 * đúng orgId này.
 */
export const findSessionActiveOrg = async (refreshToken: string): Promise<string | null> => {
  const session = await Session.findOne({ tokenHash: hashToken(refreshToken) }).select("activeOrgId").lean()
  return session?.activeOrgId ? String(session.activeOrgId) : null
}

export const setActiveOrg = async (refreshToken: string, organizationId: string): Promise<string | null> => {
  const tokenHash = hashToken(refreshToken)
  const updated = await Session.findOneAndUpdate(
    { tokenHash, isRevoked: false },
    { activeOrgId: new mongoose.Types.ObjectId(organizationId) },
    { new: true }
  )
  return updated ? String(updated._id) : null
}

export const revokeSession = async (refreshToken: string): Promise<void> => {
  const tokenHash = hashToken(refreshToken)
  await Session.findOneAndUpdate({ tokenHash }, { isRevoked: true })
}

/** Thu hồi mọi phiên của user trừ phiên đang dùng (`keepRefreshToken` hoặc `keepSessionId`), vd. sau khi đổi mật khẩu. */
export const revokeOtherUserSessions = async (
  userId: string,
  keepRefreshToken?: string,
  keepSessionId?: string
): Promise<void> => {
  let filter: Record<string, unknown> = {
    userId: new mongoose.Types.ObjectId(userId),
    isRevoked: false
  }

  if (keepRefreshToken) {
    filter = { ...filter, tokenHash: { $ne: hashToken(keepRefreshToken) } }
  } else if (keepSessionId && mongoose.isValidObjectId(keepSessionId)) {
    filter = { ...filter, _id: { $ne: new mongoose.Types.ObjectId(keepSessionId) } }
  }

  await Session.updateMany(filter, { isRevoked: true })
}

export const revokeAllUserSessions = async (userId: string): Promise<void> => {
  await Session.updateMany(
    { userId: new mongoose.Types.ObjectId(userId), isRevoked: false },
    { isRevoked: true }
  )
}

export const assertActiveSession = async (sid: string | undefined, userId: string): Promise<void> => {
  if (!sid) return
  if (!mongoose.isValidObjectId(sid)) {
    throw new ApiError(401, "Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.", "SESSION_REVOKED")
  }
  const active = await Session.exists({
    _id: sid,
    userId: new mongoose.Types.ObjectId(userId),
    isRevoked: false,
    expiresAt: { $gt: new Date() }
  })
  if (!active) {
    throw new ApiError(401, "Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.", "SESSION_REVOKED")
  }
}
