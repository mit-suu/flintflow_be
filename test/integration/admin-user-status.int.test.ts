/**
 * UC-60 (r2: UC-66) Administrator khoá tài khoản / UC-61 (r2: UC-67) mở khoá lại.
 * Khoá ⇒ mọi phiên bị thu hồi, access token còn hạn bị chặn từ request kế tiếp, không đăng nhập hay
 * gia hạn phiên được nữa (UC-03). Mở khoá (bắt buộc lý do) ⇒ đăng nhập lại bình thường. Đã ở trạng thái đó ⇒ 409.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Session } from "../../src/shared/auth/session.model.js"
import { authAs } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

const EMAIL = "member@flintflow.test"
const PASSWORD = "test-password-123"

let adminId: string
let admin: string
let memberId: string

beforeEach(async () => {
  const adminUser = await User.create({
    email: "admin@flintflow.test",
    password: PASSWORD,
    role: "admin",
    emailVerified: true
  })
  adminId = String(adminUser._id)
  admin = await authAs({ _id: adminUser._id, email: adminUser.email, role: "admin" })

  const member = await User.create({ email: EMAIL, password: PASSWORD, emailVerified: true })
  memberId = String(member._id)
})

const setStatus = (id: string, body: Record<string, unknown>, token = admin) =>
  request(app).patch(`/api/v1/admin/users/${id}/status`).set(bearer(token)).send(body)

const login = () => {
  const agent = request.agent(app)
  return agent
    .post("/api/v1/auth/login")
    .send({ email: EMAIL, password: PASSWORD })
    .then((res) => ({ agent, res }))
}

describe("UC-66 — khoá tài khoản", () => {
  it("lưu lý do, thu hồi mọi phiên; token còn hạn bị chặn, refresh và đăng nhập lại đều bị từ chối", async () => {
    const { agent, res: loggedIn } = await login()
    expect(loggedIn.status).toBe(200)
    const accessToken = loggedIn.body.data.accessToken as string

    const res = await setStatus(memberId, { isActive: false, reason: "Spam tạo project hàng loạt" })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ isActive: false, suspendReason: "Spam tạo project hàng loạt" })
    expect(res.body.data.suspendedAt).toBeTruthy()

    expect(await Session.countDocuments({ userId: memberId, isRevoked: false })).toBe(0)

    const me = await request(app).get("/api/v1/users/me").set(bearer(accessToken))
    expect(me.status).toBe(403)
    expect(me.body.error.code).toBe("ACCOUNT_SUSPENDED")

    const refreshed = await agent.post("/api/v1/auth/refresh")
    expect(refreshed.status).toBe(403)
    expect(refreshed.body.error.code).toBe("ACCOUNT_SUSPENDED")

    const again = await login()
    expect(again.res.status).toBe(403)
    expect(again.res.body.error.code).toBe("ACCOUNT_SUSPENDED")
  })

  it("sai mật khẩu thì vẫn báo sai thông tin, không lộ việc tài khoản bị khoá", async () => {
    await setStatus(memberId, { isActive: false, reason: "Vi phạm điều khoản" })

    const res = await request(app).post("/api/v1/auth/login").send({ email: EMAIL, password: "wrong-password" })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS")
  })

  it("thiếu lý do ⇒ 400, tài khoản vẫn hoạt động", async () => {
    const res = await setStatus(memberId, { isActive: false })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
    expect((await User.findById(memberId))?.isActive).toBe(true)
  })

  it("khoá tài khoản đã bị khoá ⇒ 409 USER_ALREADY_SUSPENDED, giữ nguyên lý do và thời điểm cũ", async () => {
    await setStatus(memberId, { isActive: false, reason: "Lần khoá đầu" })
    const before = await User.findById(memberId)

    const res = await setStatus(memberId, { isActive: false, reason: "Lần khoá thứ hai" })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("USER_ALREADY_SUSPENDED")
    const after = await User.findById(memberId)
    expect(after?.suspendReason).toBe("Lần khoá đầu")
    expect(after?.suspendedAt?.getTime()).toBe(before?.suspendedAt?.getTime())
  })

  it("admin không tự khoá được chính mình", async () => {
    const res = await setStatus(adminId, { isActive: false, reason: "Thử tự khoá" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("CANNOT_SUSPEND_SELF")
  })

  it("user không tồn tại ⇒ 404; người không phải admin ⇒ 403", async () => {
    const missing = await setStatus("64b0000000000000000000ff", { isActive: false, reason: "Không tồn tại" })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("USER_NOT_FOUND")

    const memberToken = await authAs({ _id: memberId, email: EMAIL })
    const forbidden = await setStatus(adminId, { isActive: false, reason: "Không phải admin" }, memberToken)
    expect(forbidden.status).toBe(403)
  })

  it("danh sách và chi tiết user của admin hiện lý do khoá", async () => {
    await setStatus(memberId, { isActive: false, reason: "Lạm dụng credit" })

    const detail = await request(app).get(`/api/v1/admin/users/${memberId}`).set(bearer(admin))
    expect(detail.body.data).toMatchObject({ isActive: false, suspendReason: "Lạm dụng credit" })

    const list = await request(app).get("/api/v1/admin/users?isActive=false").set(bearer(admin))
    expect(list.body.data.map((u: { _id: string }) => u._id)).toEqual([memberId])
  })
})

describe("UC-67 — mở khoá tài khoản", () => {
  it("xoá lý do khoá, ghi lý do mở khoá và cho đăng nhập lại", async () => {
    await setStatus(memberId, { isActive: false, reason: "Nghi bị chiếm tài khoản" })

    const res = await setStatus(memberId, { isActive: true, reason: "Đã xác minh chủ tài khoản" })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ isActive: true, suspendedAt: null, suspendReason: null, reactivateReason: "Đã xác minh chủ tài khoản" })
    expect(res.body.data.reactivatedAt).toBeTruthy()

    const { res: loggedIn } = await login()
    expect(loggedIn.status).toBe(200)
  })

  it("thiếu lý do ⇒ 400, tài khoản vẫn bị khoá", async () => {
    await setStatus(memberId, { isActive: false, reason: "Vi phạm điều khoản" })

    const res = await setStatus(memberId, { isActive: true })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
    expect((await User.findById(memberId))?.isActive).toBe(false)
  })

  it("mở khoá tài khoản đang hoạt động ⇒ 409 USER_ALREADY_ACTIVE, không đổi gì, không thu hồi phiên", async () => {
    await login()

    const res = await setStatus(memberId, { isActive: true, reason: "Thử mở khoá" })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("USER_ALREADY_ACTIVE")
    expect((await User.findById(memberId))?.reactivateReason ?? null).toBeNull()
    expect(await Session.countDocuments({ userId: memberId, isRevoked: false })).toBe(1)
  })
})
