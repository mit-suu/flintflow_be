import { Request, Response, NextFunction } from "express"
import { ApiError } from "../utils/api-error.js"

interface RateLimitOptions {
  windowMs: number
  max: number
  message?: string
}

interface RequestLog {
  count: number
  resetTime: number
}

export const createRateLimiter = (options: RateLimitOptions) => {
  const { windowMs, max, message = "Too many requests. Please try again later." } = options
  const ipStore = new Map<string, RequestLog>()

  // Cleanup expired entries periodically (every 5 minutes)
  setInterval(() => {
    const now = Date.now()
    for (const [ip, log] of ipStore.entries()) {
      if (now > log.resetTime) {
        ipStore.delete(ip)
      }
    }
  }, 5 * 60 * 1000)

  return (req: Request, _res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || "unknown"
    const now = Date.now()

    const log = ipStore.get(ip)

    if (!log || now > log.resetTime) {
      ipStore.set(ip, {
        count: 1,
        resetTime: now + windowMs
      })
      return next()
    }

    if (log.count >= max) {
      throw new ApiError(429, message, "RATE_LIMIT_EXCEEDED")
    }

    log.count += 1
    next()
  }
}

// Default placeholder middleware for backward compatibility
export const rateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 100
})

// Specific rate limiter for auth email requests (3 attempts per 15 mins)
export const authEmailRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: "Quá nhiều yêu cầu gửi email. Vui lòng thử lại sau 15 phút."
})
