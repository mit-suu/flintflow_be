/**
 * Ngôn ngữ của user (T25) — `/auth/register`, `/auth/login`, `/auth/forgot-password`, `/users/me` qua HTTP trên
 * Mongo thật. Chỉ mock chỗ gửi email để bắt ngôn ngữ được dùng; user, token, session là code thật.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/email/email.service.js", () => ({
  sendVerificationEmail: vi.fn(async () => {}),
  sendPasswordResetEmail: vi.fn(async () => {})
}))

import app from "../../src/app.js"
import { authAs } from "../setup.js"
import { User } from "../../src/modules/user/user.model.js"
import { sendPasswordResetEmail, sendVerificationEmail } from "../../src/shared/email/email.service.js"

const API = "/api/v1"

beforeEach(() => {
  vi.mocked(sendVerificationEmail).mockClear()
  vi.mocked(sendPasswordResetEmail).mockClear()
})

describe("user locale (T25)", () => {
  it("đăng ký kèm locale ⇒ lưu vào tài khoản, email xác thực gửi đúng ngôn ngữ", async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ email: "alex@example.com", password: "secret-123", name: "Alex", locale: "en" })
    expect(res.status).toBe(201)

    const user = await User.findOne({ email: "alex@example.com" })
    expect(user?.locale).toBe("en")
    expect(sendVerificationEmail).toHaveBeenCalledWith("alex@example.com", expect.any(String), "Alex", "en")
  })

  it("đăng ký không gửi locale ⇒ mặc định vi", async () => {
    await request(app).post(`${API}/auth/register`).send({ email: "mai@example.com", password: "secret-123" }).expect(201)
    expect((await User.findOne({ email: "mai@example.com" }))?.locale).toBe("vi")
    expect(sendVerificationEmail).toHaveBeenCalledWith("mai@example.com", expect.any(String), undefined, "vi")
  })

  it("locale lạ khi đăng ký ⇒ 400 VALIDATION_ERROR", async () => {
    const res = await request(app).post(`${API}/auth/register`).send({ email: "x@example.com", password: "secret-123", locale: "fr" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("đăng nhập trả về locale của tài khoản", async () => {
    await User.create({ email: "lan@example.com", password: "secret-123", emailVerified: true, locale: "en" })
    const res = await request(app).post(`${API}/auth/login`).send({ email: "lan@example.com", password: "secret-123" })
    expect(res.status).toBe(200)
    expect(res.body.data.user.locale).toBe("en")
  })

  it("quên mật khẩu ⇒ email theo ngôn ngữ của tài khoản", async () => {
    await User.create({ email: "binh@example.com", password: "secret-123", emailVerified: true, locale: "en" })
    await request(app).post(`${API}/auth/forgot-password`).send({ email: "binh@example.com" }).expect(200)
    expect(sendPasswordResetEmail).toHaveBeenCalledWith("binh@example.com", expect.any(String), undefined, "en")
  })

  it("GET /users/me có locale; PATCH đổi được; giá trị lạ bị từ chối", async () => {
    const user = await User.create({ email: "an@example.com", password: "secret-123", emailVerified: true })
    const auth = { Authorization: `Bearer ${await authAs({ _id: user._id, email: user.email })}` }

    const before = await request(app).get(`${API}/users/me`).set(auth)
    expect(before.body.data.locale).toBe("vi")

    const patched = await request(app).patch(`${API}/users/me`).set(auth).send({ locale: "en" })
    expect(patched.status).toBe(200)
    expect(patched.body.data.locale).toBe("en")
    expect((await request(app).get(`${API}/users/me`).set(auth)).body.data.locale).toBe("en")

    const bad = await request(app).patch(`${API}/users/me`).set(auth).send({ locale: "fr" })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("VALIDATION_ERROR")
  })
})
