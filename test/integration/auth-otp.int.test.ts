/**
 * auth OTP — đăng ký và quên mật khẩu đều gửi mã 6 số qua email, mã hết hạn sau 2 phút, gửi lại thì mã
 * cũ mất hiệu lực, nhập sai quá 5 lần thì khoá mã.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

const sent = vi.hoisted(() => [] as Array<{ to: string; otp: string; purpose: string }>)
vi.mock("../../src/shared/email/email.service.js", () => ({
  sendVerificationOtpEmail: vi.fn(async (to: string, otp: string) => {
    sent.push({ to, otp, purpose: "verify_email" })
  }),
  sendPasswordResetOtpEmail: vi.fn(async (to: string, otp: string) => {
    sent.push({ to, otp, purpose: "reset_password" })
  })
}))

import app from "../../src/app.js"
import { AuthToken } from "../../src/modules/auth/auth-token.model.js"
import { User } from "../../src/modules/user/user.model.js"
import { Session } from "../../src/shared/auth/session.model.js"

const EMAIL = "otp-user@flintflow.test"
const lastOtp = () => sent[sent.length - 1].otp
const register = () =>
  request(app).post("/api/v1/auth/register").send({ email: EMAIL, password: "Fixture2026!", name: "OTP" })
const confirm = (otp: string) => request(app).post("/api/v1/auth/verify-email/confirm").send({ email: EMAIL, otp })
const wrongOtp = (otp: string) => (otp === "000000" ? "000001" : "000000")

beforeEach(() => {
  sent.length = 0
})

describe("xác thực email bằng OTP", () => {
  it("đăng ký gửi OTP 6 số, nhập đúng ⇒ xác thực + đăng nhập luôn", async () => {
    const res = await register()
    expect(res.status).toBe(201)
    expect(res.body.data.otpExpiresIn).toBe(120)
    expect(sent).toHaveLength(1)
    expect(lastOtp()).toMatch(/^\d{6}$/)

    const token = await AuthToken.findOne({ type: "verify_email" })
    const ttl = token!.expiresAt.getTime() - token!.createdAt.getTime()
    expect(ttl).toBeGreaterThan(115_000)
    expect(ttl).toBeLessThanOrEqual(120_000)

    const ok = await confirm(lastOtp())
    expect(ok.status).toBe(200)
    expect(ok.body.data.accessToken).toBeTruthy()
    expect((await User.findOne({ email: EMAIL }))!.emailVerified).toBe(true)

    const again = await confirm(lastOtp())
    expect(again.body.error.code).toBe("EMAIL_ALREADY_VERIFIED")
  })

  it("mã hết hạn ⇒ OTP_EXPIRED; gửi lại ⇒ mã mới dùng được, mã cũ mất hiệu lực", async () => {
    await register()
    const oldOtp = lastOtp()
    await AuthToken.updateOne({ type: "verify_email" }, { expiresAt: new Date(Date.now() - 1000) })

    const expired = await confirm(oldOtp)
    expect(expired.status).toBe(400)
    expect(expired.body.error.code).toBe("OTP_EXPIRED")

    const resend = await request(app).post("/api/v1/auth/verify-email/resend").send({ email: EMAIL })
    expect(resend.status).toBe(200)
    expect(sent).toHaveLength(2)
    expect(await AuthToken.countDocuments({ type: "verify_email" })).toBe(1)

    if (lastOtp() !== oldOtp) {
      expect((await confirm(oldOtp)).body.error.code).toBe("INVALID_OTP")
    }
    expect((await confirm(lastOtp())).status).toBe(200)
  })

  it("nhập sai 5 lần ⇒ khoá mã, kể cả nhập đúng sau đó", async () => {
    await register()
    const otp = lastOtp()

    for (let i = 1; i <= 4; i++) {
      const res = await confirm(wrongOtp(otp))
      expect(res.body.error.code).toBe("INVALID_OTP")
      expect(res.body.error.message).toContain(`còn ${5 - i} lần`)
    }
    expect((await confirm(wrongOtp(otp))).body.error.code).toBe("OTP_TOO_MANY_ATTEMPTS")
    expect((await confirm(otp)).body.error.code).toBe("OTP_TOO_MANY_ATTEMPTS")
  })

  it("OTP sai định dạng ⇒ 400 VALIDATION_ERROR", async () => {
    const res = await confirm("12ab56")
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("resend cho email không tồn tại ⇒ 200 nhưng không gửi (chống dò email)", async () => {
    const res = await request(app).post("/api/v1/auth/verify-email/resend").send({ email: "nobody@flintflow.test" })
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(0)
  })
})

describe("đăng nhập", () => {
  it("đăng nhập 2 lần liên tiếp (cùng giây) ⇒ cả hai 200, hai phiên riêng", async () => {
    await User.create({ email: EMAIL, password: "Fixture2026!", emailVerified: true })
    const login = () => request(app).post("/api/v1/auth/login").send({ email: EMAIL, password: "Fixture2026!" })

    const [first, second] = await Promise.all([login(), login()])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await Session.countDocuments({ isRevoked: false })).toBe(2)
  })
})

describe("quên mật khẩu bằng OTP (2 bước: xác nhận OTP ⇒ đặt mật khẩu mới)", () => {
  const forgot = (email = EMAIL) => request(app).post("/api/v1/auth/forgot-password").send({ email })
  const verifyOtp = (otp: string) =>
    request(app).post("/api/v1/auth/reset-password/verify-otp").send({ email: EMAIL, otp })
  const reset = (resetToken: string, password = "new-password-456") =>
    request(app).post("/api/v1/auth/reset-password").send({ resetToken, password })
  const login = (password: string) => request(app).post("/api/v1/auth/login").send({ email: EMAIL, password })

  beforeEach(async () => {
    await User.create({ email: EMAIL, password: "old-password-123", emailVerified: true })
  })

  it("OTP đúng ⇒ nhận resetToken; đặt mật khẩu mới ⇒ đổi mật khẩu + thu hồi mọi phiên", async () => {
    await login("old-password-123")
    expect(await Session.countDocuments({})).toBeGreaterThan(0)

    const res = await forgot()
    expect(res.status).toBe(200)
    expect(res.body.data.otpExpiresIn).toBe(120)
    expect(sent).toEqual([expect.objectContaining({ to: EMAIL, purpose: "reset_password" })])
    expect(lastOtp()).toMatch(/^\d{6}$/)

    const verified = await verifyOtp(lastOtp())
    expect(verified.status).toBe(200)
    expect(verified.body.data.resetTokenExpiresIn).toBe(600)
    const { resetToken } = verified.body.data
    expect(resetToken).toMatch(/^[0-9a-f]{64}$/)

    // Xác nhận OTP chưa đổi gì
    expect((await login("old-password-123")).status).toBe(200)

    expect((await reset(resetToken)).status).toBe(200)
    expect(await Session.countDocuments({ isRevoked: false })).toBe(0)
    expect((await login("old-password-123")).status).toBe(401)
    expect((await login("new-password-456")).status).toBe(200)

    // OTP và vé đều chỉ dùng được một lần
    expect((await verifyOtp(lastOtp())).body.error.code).toBe("OTP_EXPIRED")
    expect((await reset(resetToken, "another-password-789")).body.error.code).toBe("RESET_SESSION_EXPIRED")
  })

  it("OTP sai ⇒ INVALID_OTP, không cấp vé; OTP hết hạn ⇒ OTP_EXPIRED", async () => {
    await forgot()
    const otp = lastOtp()

    const wrong = await verifyOtp(wrongOtp(otp))
    expect(wrong.body.error.code).toBe("INVALID_OTP")
    expect(wrong.body.data?.resetToken).toBeUndefined()
    expect(await AuthToken.countDocuments({ type: "reset_password_grant" })).toBe(0)

    await AuthToken.updateOne({ type: "reset_password" }, { expiresAt: new Date(Date.now() - 1000) })
    expect((await verifyOtp(otp)).body.error.code).toBe("OTP_EXPIRED")
  })

  it("vé quá 10 phút hoặc vé bịa ⇒ RESET_SESSION_EXPIRED, mật khẩu giữ nguyên", async () => {
    await forgot()
    const { resetToken } = (await verifyOtp(lastOtp())).body.data
    await AuthToken.updateOne({ type: "reset_password_grant" }, { expiresAt: new Date(Date.now() - 1000) })

    expect((await reset(resetToken)).body.error.code).toBe("RESET_SESSION_EXPIRED")
    expect((await reset("f".repeat(64))).body.error.code).toBe("RESET_SESSION_EXPIRED")
    expect((await login("old-password-123")).status).toBe(200)
  })

  it("không còn đặt mật khẩu thẳng bằng OTP được", async () => {
    // Bị chặn ngay ở validate (thiếu resetToken) nên không cần xin OTP thật
    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ email: EMAIL, otp: "123456", password: "new-password-456" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("OTP xác thực email không dùng được để đặt lại mật khẩu", async () => {
    await User.updateOne({ email: EMAIL }, { emailVerified: false })
    await request(app).post("/api/v1/auth/verify-email/resend").send({ email: EMAIL })
    expect(sent[0].purpose).toBe("verify_email")

    expect((await verifyOtp(sent[0].otp)).body.error.code).toBe("OTP_EXPIRED")
  })

  it("tài khoản Google (chưa có mật khẩu) ⇒ nhận OTP và tạo được mật khẩu, vẫn đăng nhập Google được", async () => {
    const GOOGLE_EMAIL = "google-only@flintflow.test"
    await User.create({ email: GOOGLE_EMAIL, name: "G", authProvider: "google", googleId: "g-1", emailVerified: true })

    const res = await forgot(GOOGLE_EMAIL)
    expect(res.status).toBe(200)
    expect(sent).toEqual([expect.objectContaining({ to: GOOGLE_EMAIL, purpose: "reset_password" })])

    const verified = await request(app)
      .post("/api/v1/auth/reset-password/verify-otp")
      .send({ email: GOOGLE_EMAIL, otp: lastOtp() })
    expect(verified.status).toBe(200)
    expect((await reset(verified.body.data.resetToken, "created-password-1")).status).toBe(200)

    const login = await request(app).post("/api/v1/auth/login").send({ email: GOOGLE_EMAIL, password: "created-password-1" })
    expect(login.status).toBe(200)
    const user = await User.findOne({ email: GOOGLE_EMAIL })
    expect(user!.authProvider).toBe("google")
    expect(user!.googleId).toBe("g-1")
  })

  it("email không tồn tại ⇒ 200 nhưng không gửi (chống dò email)", async () => {
    const res = await forgot("nobody@flintflow.test")
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(0)
  })
})
