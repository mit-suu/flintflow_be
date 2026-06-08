import jwt from "jsonwebtoken"

export interface TokenPayload {
  userId: string
  email: string
}

export const generateAccessToken = (payload: TokenPayload): string => {
  const secret = (process.env.JWT_ACCESS_SECRET || "access-secret") as string
  const expiresIn = process.env.ACCESS_TOKEN_EXPIRES || "15m"

  return (jwt.sign as any)(payload, secret, { expiresIn })
}

export const generateRefreshToken = (payload: TokenPayload): string => {
  const secret = (process.env.JWT_REFRESH_SECRET || "refresh-secret") as string
  const expiresIn = process.env.REFRESH_TOKEN_EXPIRES || "7d"

  return (jwt.sign as any)(payload, secret, { expiresIn })
}

export const verifyAccessToken = (token: string): TokenPayload => {
  const secret = (process.env.JWT_ACCESS_SECRET || "access-secret") as string
  return jwt.verify(token, secret) as TokenPayload
}

export const verifyRefreshToken = (token: string): TokenPayload => {
  const secret = (process.env.JWT_REFRESH_SECRET || "refresh-secret") as string
  return jwt.verify(token, secret) as TokenPayload
}
