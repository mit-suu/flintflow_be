/**
 * Trang hồ sơ — `GET /users/me` trả thêm thông tin tài khoản, `POST /users/me/password` đổi mật khẩu khi
 * đang đăng nhập: cần mật khẩu hiện tại, giữ phiên đang dùng, thu hồi mọi phiên khác.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Session } from "../../src/shared/auth/session.model.js"

const EMAIL = "profile-user@flintflow.test"
const PASSWORD = "Fixture2026!"

/** Đăng nhập bằng agent riêng (giữ cookie refreshToken như một trình duyệt). */
const loginAgent = async () => {
  const agent = request.agent(app)
  const res = await agent.post("/api/v1/auth/login").send({ email: EMAIL, password: PASSWORD })
  expect(res.status).toBe(200)
  return { agent, auth: { Authorization: `Bearer ${res.body.data.accessToken}` } }
}

const seedLocalUser = () => User.create({ email: EMAIL, password: PASSWORD, name: "Hiệp", emailVerified: true })

describe("GET /users/me", () => {
  it("trả authProvider, emailVerified, hasPassword; không lộ passwordHash", async () => {
    await seedLocalUser()
    const { agent, auth } = await loginAgent()

    const res = await agent.get("/api/v1/users/me").set(auth)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      email: EMAIL,
      name: "Hiệp",
      authProvider: "local",
      emailVerified: true,
      hasPassword: true
    })
    expect(res.body.data).not.toHaveProperty("passwordHash")
  })
})

describe("POST /users/me/password", () => {
  it("đúng mật khẩu hiện tại ⇒ đổi được, phiên hiện tại giữ nguyên, phiên khác bị thu hồi", async () => {
    await seedLocalUser()
    const other = await loginAgent()
    const current = await loginAgent()
    expect(await Session.countDocuments({ isRevoked: false })).toBe(2)

    const res = await current.agent
      .post("/api/v1/users/me/password")
      .set(current.auth)
      .send({ currentPassword: PASSWORD, newPassword: "new-password-456" })
    expect(res.status).toBe(200)

    expect(await Session.countDocuments({ isRevoked: false })).toBe(1)
    expect((await current.agent.post("/api/v1/auth/refresh")).status).toBe(200)
    expect((await other.agent.post("/api/v1/auth/refresh")).status).toBe(401)

    const login = (password: string) => request(app).post("/api/v1/auth/login").send({ email: EMAIL, password })
    expect((await login(PASSWORD)).status).toBe(401)
    expect((await login("new-password-456")).status).toBe(200)
  })

  it("sai mật khẩu hiện tại ⇒ 400 INVALID_CURRENT_PASSWORD (không phải 401), mật khẩu giữ nguyên", async () => {
    await seedLocalUser()
    const { agent, auth } = await loginAgent()

    const res = await agent
      .post("/api/v1/users/me/password")
      .set(auth)
      .send({ currentPassword: "wrong-password", newPassword: "new-password-456" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("INVALID_CURRENT_PASSWORD")
    expect((await request(app).post("/api/v1/auth/login").send({ email: EMAIL, password: PASSWORD })).status).toBe(200)
  })

  it("trùng mật khẩu cũ ⇒ SAME_PASSWORD; yếu / chưa đủ mạnh / có dấu ⇒ VALIDATION_ERROR", async () => {
    await seedLocalUser()
    const { agent, auth } = await loginAgent()
    const change = (newPassword: string) =>
      agent.post("/api/v1/users/me/password").set(auth).send({ currentPassword: PASSWORD, newPassword })

    expect((await change(PASSWORD)).body.error.code).toBe("SAME_PASSWORD")
    expect((await change("123")).body.error.code).toBe("VALIDATION_ERROR")
    // Qua hết luật cứng nhưng mới mức "Trung bình" ⇒ vẫn chặn, vì ngưỡng là "Khá"
    expect((await change("muaroi2!")).body.error.code).toBe("VALIDATION_ERROR")
    expect((await change("Đườngxưa1!")).body.error.code).toBe("VALIDATION_ERROR")
  })

  it("tài khoản Google (chưa có mật khẩu) ⇒ hasPassword=false, đổi mật khẩu ⇒ PASSWORD_NOT_SET", async () => {
    const user = await User.create({ email: EMAIL, name: "G", authProvider: "google", googleId: "g-1", emailVerified: true })
    const { signAccessToken } = await import("../../src/shared/auth/jwt.util.js")
    const auth = { Authorization: `Bearer ${signAccessToken({ userId: user._id.toString(), email: EMAIL, role: "user" })}` }

    expect((await request(app).get("/api/v1/users/me").set(auth)).body.data.hasPassword).toBe(false)
    const res = await request(app)
      .post("/api/v1/users/me/password")
      .set(auth)
      .send({ currentPassword: "anything", newPassword: "new-password-456" })
    expect(res.body.error.code).toBe("PASSWORD_NOT_SET")
  })

  it("chưa đăng nhập ⇒ 401", async () => {
    const res = await request(app)
      .post("/api/v1/users/me/password")
      .send({ currentPassword: PASSWORD, newPassword: "new-password-456" })
    expect(res.status).toBe(401)
  })
})
