import { describe, expect, it } from "vitest"
import { authCookieOptions } from "./auth-cookie.js"

describe("authCookieOptions (FLF-137)", () => {
  it("mặc định dev: lax, không Secure, host-only", () => {
    const opts = authCookieOptions({ nodeEnv: "development", sameSite: "lax", domain: "" })

    expect(opts).toEqual({ httpOnly: true, secure: false, sameSite: "lax", path: "/" })
    expect(opts).not.toHaveProperty("domain")
  })

  it("production ⇒ Secure", () => {
    expect(authCookieOptions({ nodeEnv: "production", sameSite: "lax", domain: "" }).secure).toBe(true)
  })

  it("SameSite=None luôn kèm Secure, kể cả ngoài production — trình duyệt từ chối None thiếu Secure", () => {
    const opts = authCookieOptions({ nodeEnv: "development", sameSite: "none", domain: "" })

    expect(opts.sameSite).toBe("none")
    expect(opts.secure).toBe(true)
  })

  it("COOKIE_DOMAIN có giá trị ⇒ gắn domain để FE cùng site đọc được cookie", () => {
    const opts = authCookieOptions({ nodeEnv: "production", sameSite: "lax", domain: ".flintflow.io.vn" })

    expect(opts.domain).toBe(".flintflow.io.vn")
  })
})
