import jwt, { SignOptions } from "jsonwebtoken"
import crypto from "crypto"
import { env } from "../../config/env.js"

export interface TokenPayload {
  userId: string
  email: string
  /**
   * Vai trò NỀN TẢNG (user | admin) — không phải vai trò trong org. BPMN Flow 10.4 nói rõ vai trò mang
   * trong token không bao giờ được tin: mọi guard đọc lại từ DB (adminMiddleware, orgContext).
   */
  role?: string
  /**
   * Org đang mở (task-26). Nguồn: Session.activeOrgId lúc đăng nhập / đổi org (Flow 7.13, 9.3).
   * Chỉ cho biết người dùng ĐANG làm việc ở org nào — quyền vẫn do Membership trong DB quyết định.
   */
  orgId?: string
}

export const signAccessToken = (payload: TokenPayload): string => {
  const options: SignOptions = {
    expiresIn: env.ACCESS_TOKEN_EXPIRES as any
  }
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options)
}

export const signRefreshToken = (payload: TokenPayload, expiresIn: string = env.REFRESH_TOKEN_EXPIRES): string => {
  const options: SignOptions = {
    expiresIn: expiresIn as any,
    // `iat` chỉ chính xác tới giây: thiếu `jti` thì hai lần đăng nhập/refresh trong cùng giây sinh token
    // giống hệt nhau ⇒ trùng `tokenHash` (unique) của Session ⇒ 500.
    jwtid: crypto.randomUUID()
  }
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, options)
}

export const verifyAccessToken = (token: string): TokenPayload => {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload
}

export const verifyRefreshToken = (token: string): TokenPayload => {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload
}

export const hashToken = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex")
}
