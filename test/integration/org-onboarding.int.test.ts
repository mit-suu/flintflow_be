/**
 * task-26 Pha 5 — (1) onboarding xong khi tài khoản vào được một org (BPMN Flow 8, điểm kết thúc);
 * (2) thông báo lọc theo org đang mở, một người ở nhiều org không thấy lẫn.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { notify } from "../../src/modules/notification/notification.service.js"
import { authAs } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

let user: { id: string; email: string; token: string }

beforeEach(async () => {
  const created = await User.create({ email: "new@flintflow.test", password: "test-password-123", emailVerified: true })
  user = { id: String(created._id), email: created.email, token: await authAs({ _id: created._id, email: created.email }) }
})

const onboardedAt = async (id: string) => (await User.findById(id).lean())?.onboardedAt ?? null

describe("onboarding xong khi vào được một org (Flow 8)", () => {
  it("tạo org thì onboardedAt được ghi", async () => {
    expect(await onboardedAt(user.id)).toBeNull()

    const res = await request(app).post("/api/v1/orgs").set(bearer(user.token)).send({ name: "Org mới" })
    expect(res.status).toBe(201)
    expect(await onboardedAt(user.id)).not.toBeNull()
  })

  it("nhận mã mời thì onboardedAt được ghi", async () => {
    const lead = await User.create({ email: "lead@flintflow.test", password: "test-password-123", emailVerified: true })
    const leadToken = await authAs({ _id: lead._id, email: lead.email })
    const org = await request(app).post("/api/v1/orgs").set(bearer(leadToken)).send({ name: "Org A" })
    const invite = await request(app)
      .post("/api/v1/orgs/" + org.body.data.id + "/invitations")
      .set(bearer(leadToken))
      .send({ role: "viewer" })

    expect(await onboardedAt(user.id)).toBeNull()
    const accept = await request(app).post("/api/v1/invitations/" + invite.body.data.code + "/accept").set(bearer(user.token))
    expect(accept.status).toBe(200)
    expect(await onboardedAt(user.id)).not.toBeNull()
  })

  it("vào org thứ hai không ghi đè mốc onboarding đầu tiên", async () => {
    await request(app).post("/api/v1/orgs").set(bearer(user.token)).send({ name: "Org 1" })
    const first = await onboardedAt(user.id)

    await new Promise((resolve) => setTimeout(resolve, 20))
    await request(app).post("/api/v1/orgs").set(bearer(user.token)).send({ name: "Org 2" })

    expect((await onboardedAt(user.id))?.getTime()).toBe(first?.getTime())
  })

  it("chưa có org thì tài nguyên của org trả 409 để FE đẩy về onboarding", async () => {
    const res = await request(app).get("/api/v1/projects").set(bearer(user.token))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("NO_ACTIVE_ORG")
  })
})

describe("thông báo theo org đang mở", () => {
  let orgA: string
  let orgB: string

  beforeEach(async () => {
    orgA = (await request(app).post("/api/v1/orgs").set(bearer(user.token)).send({ name: "Org A" })).body.data.id
    orgB = (await request(app).post("/api/v1/orgs").set(bearer(user.token)).send({ name: "Org B" })).body.data.id
    await notify(user.id, { type: "t", title: "Của A", body: "", organizationId: orgA })
    await notify(user.id, { type: "t", title: "Của B", body: "", organizationId: orgB })
    await notify(user.id, { type: "welcome", title: "Nền tảng", body: "" })
  })

  const titles = async (token: string) => {
    const res = await request(app).get("/api/v1/notifications").set(bearer(token))
    expect(res.status).toBe(200)
    return (res.body.data as Array<{ title: string }>).map((n) => n.title).sort()
  }

  it("đang mở org A thì thấy thông báo của A và của nền tảng, không thấy của B", async () => {
    const token = await authAs({ _id: user.id, email: user.email, orgId: orgA })
    expect(await titles(token)).toEqual(["Của A", "Nền tảng"])
  })

  it("chưa chọn org thì chỉ thấy thông báo cấp nền tảng", async () => {
    expect(await titles(user.token)).toEqual(["Nền tảng"])
  })

  it("đếm chưa đọc và đánh dấu đọc hết chỉ trong phạm vi org đang mở", async () => {
    const tokenA = await authAs({ _id: user.id, email: user.email, orgId: orgA })
    const tokenB = await authAs({ _id: user.id, email: user.email, orgId: orgB })

    const countA = await request(app).get("/api/v1/notifications/unread-count").set(bearer(tokenA))
    expect(countA.body.data.count).toBe(2)

    await request(app).patch("/api/v1/notifications/read-all").set(bearer(tokenA))

    const countB = await request(app).get("/api/v1/notifications/unread-count").set(bearer(tokenB))
    // Thông báo của B vẫn chưa đọc; thông báo nền tảng đã được đọc cùng lượt ở A
    expect(countB.body.data.count).toBe(1)
  })
})
