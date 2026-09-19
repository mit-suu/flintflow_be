/**
 * "Ghi nhớ tài khoản" lúc đăng nhập:
 *  - tick (`rememberMe: true`) ⇒ phiên 30 ngày, cookie refreshToken bền 30 ngày;
 *  - không tick (`false`) ⇒ cookie phiên (không Max-Age/Expires) — đóng trình duyệt là mất;
 *  - bỏ trống (client cũ, Google) ⇒ như trước: 3 ngày.
 * Chế độ phải được giữ nguyên qua mỗi lần `/auth/refresh` xoay vòng token.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Session } from "../../src/shared/auth/session.model.js"

const EMAIL = "remember-user@flintflow.test"
const PASSWORD = "password-123"
const DAY_MS = 24 * 60 * 60 * 1000

const cookieOf = (res: request.Response, name: string): string => {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined
  const cookie = raw?.find((c) => c.startsWith(`${name}=`))
  expect(cookie, `thiếu cookie ${name}`).toBeDefined()
  return cookie as string
}

const maxAgeSeconds = (cookie: string): number | null => {
  const match = cookie.match(/Max-Age=(\d+)/i)
  return match ? Number(match[1]) : null
}

const login = (rememberMe?: boolean) => {
  const agent = request.agent(app)
  const body = rememberMe === undefined ? { email: EMAIL, password: PASSWORD } : { email: EMAIL, password: PASSWORD, rememberMe }
  return agent.post("/api/v1/auth/login").send(body).then((res) => ({ agent, res }))
}

const activeSession = async () => {
  const sessions = await Session.find({ isRevoked: false })
  expect(sessions).toHaveLength(1)
  return sessions[0]
}

beforeEach(async () => {
  await User.create({ email: EMAIL, password: PASSWORD, emailVerified: true })
})

describe("đăng nhập có 'Ghi nhớ tài khoản'", () => {
  it("tick ⇒ cookie refreshToken 30 ngày, phiên hết hạn sau ~30 ngày", async () => {
    const { res } = await login(true)
    expect(res.status).toBe(200)

    expect(maxAgeSeconds(cookieOf(res, "refreshToken"))).toBe(30 * 24 * 60 * 60)
    const session = await activeSession()
    expect(session.rememberMe).toBe(true)
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY_MS)
  })

  it("không tick ⇒ cookie phiên (không Max-Age/Expires) cho cả refreshToken và accessToken", async () => {
    const { res } = await login(false)
    expect(res.status).toBe(200)

    for (const name of ["refreshToken", "accessToken"]) {
      const cookie = cookieOf(res, name)
      expect(maxAgeSeconds(cookie)).toBeNull()
      expect(cookie).not.toMatch(/Expires=/i)
    }
    expect((await activeSession()).rememberMe).toBe(false)
  })

  it("bỏ trống (client cũ) ⇒ giữ hành vi cũ: 3 ngày", async () => {
    const { res } = await login()

    expect(maxAgeSeconds(cookieOf(res, "refreshToken"))).toBe(3 * 24 * 60 * 60)
    const session = await activeSession()
    expect(session.rememberMe).toBeNull()
    expect(session.expiresAt.getTime() - Date.now()).toBeLessThan(3 * DAY_MS + 60_000)
  })

  it.each([
    [true, 30 * 24 * 60 * 60],
    [false, null],
  ])("rememberMe=%s ⇒ refresh xoay vòng vẫn giữ nguyên chế độ", async (rememberMe, expectedMaxAge) => {
    const { agent } = await login(rememberMe)

    const refreshed = await agent.post("/api/v1/auth/refresh")
    expect(refreshed.status).toBe(200)
    expect(maxAgeSeconds(cookieOf(refreshed, "refreshToken"))).toBe(expectedMaxAge)
    expect((await activeSession()).rememberMe).toBe(rememberMe)
  })

  it("rememberMe không phải boolean ⇒ 400 VALIDATION_ERROR", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email: EMAIL, password: PASSWORD, rememberMe: "yes" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})
