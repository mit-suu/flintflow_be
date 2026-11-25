import mongoose from "mongoose"
import { Session, ISession } from "./session.model.js"
import { hashToken, verifyRefreshToken } from "./jwt.util.js"
import { ApiError } from "../utils/api-error.js"
import { env } from "../../config/env.js"

export const createSession = async (
  userId: string,
  refreshToken: string,
  expiresAt: Date,
  userAgent?: string,
  ip?: string,
  rememberMe: boolean | null = null,
  activeOrgId?: string | null,
  /** FLF-475: họ phiên kế thừa khi xoay. Không truyền (đăng nhập mới) ⇒ phiên tự làm gốc họ của chính nó. */
  familyId?: mongoose.Types.ObjectId | null,
  /** FLF-475: `_id` định trước — dùng khi `rotateSession` cần biết id phiên mới TRƯỚC khi tạo (ghi `replacedBy`). */
  sessionId?: mongoose.Types.ObjectId
): Promise<ISession> => {
  const tokenHash = hashToken(refreshToken)
  const _id = sessionId ?? new mongoose.Types.ObjectId()
  return await Session.create({
    _id,
    userId: new mongoose.Types.ObjectId(userId),
    tokenHash,
    expiresAt,
    isRevoked: false,
    rememberMe,
    userAgent,
    ip,
    activeOrgId: activeOrgId && mongoose.isValidObjectId(activeOrgId) ? new mongoose.Types.ObjectId(activeOrgId) : null,
    familyId: familyId ?? _id
  })
}

/** Chế độ "ghi nhớ" của phiên ứng với refresh token (không kiểm tra hợp lệ — `rotateSession` lo việc đó). */
export const findSessionRememberMe = async (refreshToken: string): Promise<boolean | null> => {
  const session = await Session.findOne({ tokenHash: hashToken(refreshToken) }).select("rememberMe")
  return session?.rememberMe ?? null
}

/** FLF-475: theo con trỏ `replacedBy` tới phiên mới nhất chưa có ai xoay tiếp (phiên "lá" của họ). */
const followReplacedByChain = async (session: ISession): Promise<ISession> => {
  let current = session
  while (current.replacedBy) {
    const next = await Session.findById(current.replacedBy)
    if (!next) break
    current = next
  }
  return current
}

/**
 * FLF-475: chặn race storm bất thường (nhiều hơn 2 request song song cùng một token) — mỗi vòng thử
 * xoay nguyên tử một phiên "lá"; thua thì đi tiếp theo `replacedBy` rồi thử lại. Hai request song song
 * bình thường chỉ cần tối đa 2 vòng.
 */
const MAX_ROTATE_ATTEMPTS = 5

/** FLF-475: xoay nguyên tử TỪ một phiên còn hiệu lực (phiên gốc hoặc phiên "lá" tìm được trong khoảng ân hạn). */
const rotateFromLeaf = async (
  leaf: ISession,
  decoded: { userId: string; email: string },
  newRefreshToken: string,
  newExpiresAt: Date,
  userAgent?: string,
  ip?: string,
  rememberMe: boolean | null = null,
  activeOrgId?: string | null
): Promise<{ userId: string; email: string; sessionId: string }> => {
  let current = leaf
  for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS; attempt++) {
    const newId = new mongoose.Types.ObjectId()
    const revoked = await Session.findOneAndUpdate(
      { _id: current._id, isRevoked: false },
      { isRevoked: true, rotatedAt: new Date(), replacedBy: newId },
      { new: true }
    )

    if (revoked) {
      const newSession = await createSession(
        decoded.userId,
        newRefreshToken,
        newExpiresAt,
        userAgent,
        ip,
        rememberMe,
        activeOrgId,
        current.familyId ?? current._id,
        newId
      )
      return { userId: decoded.userId, email: decoded.email, sessionId: String(newSession._id) }
    }

    // Có request khác vừa xoay `current` trước mình (hai request refresh cùng token tới gần như cùng
    // lúc) — đi theo `replacedBy` tới phiên mới nhất rồi thử lại, thay vì trả 401 CONCURRENT_REFRESH.
    const refreshed = await Session.findById(current._id)
    if (!refreshed) {
      throw new ApiError(401, "Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.", "SESSION_REVOKED")
    }
    const nextLeaf = await followReplacedByChain(refreshed)
    if (nextLeaf.isRevoked) {
      // Phiên mới nhất của họ đã bị thu hồi vì lý do khác (đăng xuất / đổi mật khẩu / logout-all).
      throw new ApiError(401, "Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.", "SESSION_REVOKED")
    }
    current = nextLeaf
  }

  // Cực hiếm (nhiều hơn 2 request song song cùng token trong cùng một khoảnh khắc): coi như bất thường,
  // thu hồi họ phiên theo đúng nhánh reuse thật thay vì để lọt một mã lỗi khác.
  if (current.familyId) {
    await Session.updateMany({ familyId: current.familyId }, { isRevoked: true })
  }
  throw new ApiError(401, "Phiên đăng nhập không còn an toàn nên đã bị đăng xuất trên mọi thiết bị. Vui lòng đăng nhập lại.", "TOKEN_REUSE_DETECTED")
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

  // Phiên không tồn tại (đã bị dọn) — chữ ký JWT hợp lệ nhưng không còn bản ghi để biết họ nào mà thu hồi.
  if (!existingSession) {
    throw new ApiError(401, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", "INVALID_REFRESH_TOKEN")
  }

  // 2. Phiên đã bị thu hồi: phân biệt reuse THẬT với phản hồi xoay bị mất / request song song.
  if (existingSession.isRevoked) {
    const withinGrace =
      !!existingSession.rotatedAt &&
      Date.now() - existingSession.rotatedAt.getTime() <= env.REFRESH_REUSE_GRACE_MS

    if (withinGrace) {
      // Token vừa bị xoay trong khoảng ân hạn — có thể phản hồi trước đó bị mất giữa đường, hoặc đây là
      // request song song với lượt xoay kia. Đi tới phiên mới nhất của họ và xoay tiếp từ đó, KHÔNG thu
      // hồi gì cả, để không đăng xuất nhầm người dùng.
      const leaf = await followReplacedByChain(existingSession)
      if (!leaf.isRevoked) {
        console.info(`[refresh-grace] xoay tiếp trong khoảng ân hạn, familyId=${String(existingSession.familyId ?? existingSession._id)}`)
        return await rotateFromLeaf(leaf, decoded, newRefreshToken, newExpiresAt, userAgent, ip, rememberMe, activeOrgId)
      }
      // Phiên mới nhất của họ đã bị thu hồi vì lý do khác (đăng xuất / đổi mật khẩu / logout-all): không
      // phải reuse, không thu hồi thêm gì, chỉ báo phiên đã kết thúc.
      throw new ApiError(401, "Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.", "SESSION_REVOKED")
    }

    // Quá khoảng ân hạn, hoặc bị thu hồi không do xoay (đăng xuất, đổi mật khẩu, logout-all) ⇒ reuse thật.
    console.warn(`[REUSE DETECTION] Revoked refresh token reuse attempt for user ${decoded.userId}`)
    if (existingSession.familyId) {
      // Chỉ thu hồi họ phiên bị đánh cắp, không đụng phiên ở thiết bị / agent khác của cùng user.
      await Session.updateMany({ familyId: existingSession.familyId }, { isRevoked: true })
    } else {
      // Phiên tạo trước FLF-475 (không có familyId): không có dữ liệu để khoanh họ, giữ hành vi cũ —
      // thu hồi mọi phiên của user để an toàn.
      await Session.updateMany(
        { userId: new mongoose.Types.ObjectId(decoded.userId) },
        { isRevoked: true }
      )
    }
    throw new ApiError(401, "Phiên đăng nhập không còn an toàn nên đã bị đăng xuất trên mọi thiết bị. Vui lòng đăng nhập lại.", "TOKEN_REUSE_DETECTED")
  }

  // Check if token has expired based on DB record
  if (existingSession.expiresAt < new Date()) {
    existingSession.isRevoked = true
    await existingSession.save()
    throw new ApiError(401, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", "EXPIRED_REFRESH_TOKEN")
  }

  // 3. Xoay bình thường, nguyên tử; tự theo chuỗi họ phiên nếu có request song song khác thắng trước.
  return await rotateFromLeaf(existingSession, decoded, newRefreshToken, newExpiresAt, userAgent, ip, rememberMe, activeOrgId)
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
