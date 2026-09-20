import jwt, { SignOptions } from "jsonwebtoken"
import crypto from "crypto"
import { env } from "../../config/env.js"

export interface TokenPayload {
  userId: string
  email: string
  role?: string
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
