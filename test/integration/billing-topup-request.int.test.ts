/**
 * FLF-332 (BR-08) — Analyst báo Lead nạp credit qua HTTP trên Mongo thật: Lead nhận thông báo (không dội trùng), nạp xong
 * (webhook / admin) ⇒ người yêu cầu được báo, yêu cầu đóng. Không có lượt gọi AI nào.
 */
import { describe, expect, it, vi } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { CreditTopupRequest } from "../../src/modules/billing/credit-topup-request.model.js"
import { fulfillTopupRequests } from "../../src/modules/billing/topup-request.service.js"

const joinOrg = async (orgId: string, role: "lead" | "analyst") => {
  const email = `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}@flintflow.test`
  const user = await User.create({ email, password: "test-password-123", emailVerified: true, name: role === "analyst" ? "BA Linh" : "Lead Hai" })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return { id: String(user._id), token: await authAs({ _id: user._id, email, orgId }) }
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

const notificationsOf = async (userId: string, type: string, n: number) => {
  await vi.waitFor(async () => expect(await Notification.countDocuments({ userId, type })).toBe(n), { timeout: 3000 })
  return Notification.find({ userId, type }).sort({ createdAt: 1 }).lean()
}

describe("POST /billing/topup-request", () => {
  it("Analyst báo ⇒ yêu cầu open, mọi Lead (trừ người báo) nhận credit_topup_requested; bấm lại ⇒ cập nhật, không báo trùng", async () => {
    const seeded: SeededFixture = await seedFixture("minimal")
    const lead2 = await joinOrg(seeded.orgId, "lead")
    const analyst = await joinOrg(seeded.orgId, "analyst")

    const res = await request(app).post("/api/v1/billing/topup-request").set(bearer(analyst.token)).send({ projectId: seeded.projectId, step: "S-5.4@S03", needed: 40 })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    expect(res.body.data).toMatchObject({ status: "open", user_id: analyst.id, project_id: seeded.projectId, step: "S-5.4@S03", needed: 40, notified_leads: 2 })

    const [n] = await notificationsOf(seeded.userId, "credit_topup_requested", 1)
    expect(n.title).toContain("BA Linh cần nạp credit")
    expect(n.body).toContain("S-5.4@S03")
    expect(n.meta).toMatchObject({ requestedBy: analyst.id, needed: 40 })
    await notificationsOf(lead2.id, "credit_topup_requested", 1)
    expect(await Notification.countDocuments({ userId: analyst.id, type: "credit_topup_requested" })).toBe(0)

    const again = await request(app).post("/api/v1/billing/topup-request").set(bearer(analyst.token)).send({ needed: 60 })
    expect(again.status).toBe(201)
    expect(again.body.data).toMatchObject({ status: "open", needed: 60, notified_leads: 0 })
    expect(await CreditTopupRequest.countDocuments({ organizationId: seeded.orgId, userId: analyst.id })).toBe(1)
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "credit_topup_requested" })).toBe(1)
  })

  it("ví được nạp ⇒ yêu cầu fulfilled, người yêu cầu nhận credit_topped_up nói rõ phải bấm tiếp tục; Lead tự báo không tự nhận", async () => {
    const seeded = await seedFixture("minimal")
    const analyst = await joinOrg(seeded.orgId, "analyst")
    await request(app).post("/api/v1/billing/topup-request").set(bearer(analyst.token)).send({ projectId: seeded.projectId })
    await request(app).post("/api/v1/billing/topup-request").set(bearer(seeded.token)).send({})

    expect(await fulfillTopupRequests(seeded.orgId, 100, { kind: "payment", userId: seeded.userId })).toBe(2)
    expect(await CreditTopupRequest.countDocuments({ organizationId: seeded.orgId, status: "open" })).toBe(0)
    const [n] = await notificationsOf(analyst.id, "credit_topped_up", 1)
    expect(n.title).toContain("100 credit")
    expect(n.body).toContain("bấm tiếp tục")
    expect(n.link).toBe(`/projects/${seeded.projectId}`)
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "credit_topped_up" })).toBe(0)
    // Không còn yêu cầu mở ⇒ nạp lần nữa không báo ai
    expect(await fulfillTopupRequests(seeded.orgId, 50, { kind: "admin", userId: null })).toBe(0)
  })

  it("Viewer không báo được (403); không có org ⇒ 400/403", async () => {
    const seeded = await seedFixture("minimal")
    const viewer = await joinOrg(seeded.orgId, "lead")
    await Membership.updateOne({ userId: viewer.id, organizationId: seeded.orgId }, { $set: { role: "viewer" } })
    const res = await request(app).post("/api/v1/billing/topup-request").set(bearer(viewer.token)).send({})
    expect(res.status).toBe(403)
  })
})
