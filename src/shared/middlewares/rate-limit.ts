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

// Gửi/gửi lại OTP. Mã hết hạn sau 2 phút nên hạn mức cao hơn link cũ; mỗi luồng một bộ đếm riêng.
const createOtpSendRateLimiter = () =>
  createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Bạn đã yêu cầu gửi lại mã quá nhiều lần. Vui lòng thử lại sau 15 phút."
  })

export const otpResendRateLimiter = createOtpSendRateLimiter()
export const passwordResetOtpRateLimiter = createOtpSendRateLimiter()

// Chặn dò mật khẩu hiện tại qua form đổi mật khẩu
export const changePasswordRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Quá nhiều lần đổi mật khẩu. Vui lòng thử lại sau 15 phút."
})

// Chặn dò OTP theo IP (mỗi mã còn giới hạn 5 lần nhập sai ở tầng service).
export const otpVerifyRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Quá nhiều lần nhập mã. Vui lòng thử lại sau 15 phút."
})
