import type { CookieOptions } from "express"

export type CookieSameSite = "lax" | "strict" | "none"

export interface AuthCookieConfig {
  nodeEnv: string
  sameSite: CookieSameSite
  /** Rỗng ⇒ cookie gắn đúng host của BE (host-only). */
  domain: string
}

export const REFRESH_COOKIE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000 // 3 days
export const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Option chung cho cookie `refreshToken`/`accessToken` — cả lúc set lẫn lúc clear.
 *
 * Vì sao cấu hình được (FLF-137): production FE (`flintflow.io.vn`) và BE (`*.azurewebsites.net`) khác site,
 * nên cookie `SameSite=Lax` không được gửi kèm `fetch POST /auth/refresh` ⇒ `MISSING_REFRESH_TOKEN`.
 * Local không lộ lỗi vì `localhost:3000` và `localhost:5000` cùng site (cookie không phân biệt port).
 *   - BE khác site FE ⇒ `COOKIE_SAME_SITE=none` (bắt buộc kèm `Secure`).
 *   - BE ở subdomain cùng site (`api.flintflow.io.vn`) ⇒ giữ `lax`, đặt `COOKIE_DOMAIN=.flintflow.io.vn`
 *     để `proxy.ts` của FE cũng đọc được cookie.
 * `clearCookie` phải dùng cùng `domain/path/sameSite/secure`, nếu không trình duyệt coi là cookie khác và không xoá.
 */
export const authCookieOptions = (config: AuthCookieConfig): CookieOptions => ({
  httpOnly: true,
  // Trình duyệt từ chối `SameSite=None` thiếu `Secure`; localhost vẫn nhận cookie Secure qua http.
  secure: config.nodeEnv === "production" || config.sameSite === "none",
  sameSite: config.sameSite,
  path: "/",
  ...(config.domain ? { domain: config.domain } : {})
})
