/**
 * task-26 Pha 3 — mời và tham gia tổ chức qua API thật.
 * BPMN Flow 9.1–9.2 (Lead sinh mã, gửi email, thu hồi) và Flow 8.3–8.5 (nhập mã, kiểm mã, vào org).
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { Invitation } from "../../src/modules/organization/invitation.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { Subscription } from "../../src/modules/credits/subscription.model.js"
import { planConfig } from "../../src/modules/billing/plan.config.js"
import { authAs } from "../setup.js"
import { verifyAccessToken } from "../../src/shared/auth/jwt.util.js"

const ORGS = "/api/v1/orgs"
const INVITES = "/api/v1/invitations"

interface Actor {
  id: string
  email: string
  token: string
}

const makeUser = async (email: string): Promise<Actor> => {
  const user = await User.create({ email, password: "test-password-123", name: email, emailVerified: true })
  return { id: String(user._id), email, token: await authAs({ _id: user._id, email }) }
}

const bearer = (actor: Actor) => ({ Authorization: "Bearer " + actor.token })

let lead: Actor
let invitee: Actor
let orgId: string

beforeEach(async () => {
  lead = await makeUser("lead@flintflow.test")
  invitee = await makeUser("invitee@flintflow.test")
  const res = await request(app).post(ORGS).set(bearer(lead)).send({ name: "Org A" })
  orgId = res.body.data.id
})

// Email bắt buộc từ 2026-10-04 (góp ý mentor) ⇒ helper mặc định mời đúng người sẽ nhập mã
const invite = async (role = "analyst", email = "invitee@flintflow.test") => {
  const res = await request(app)
    .post(ORGS + "/" + orgId + "/invitations")
    .set(bearer(lead))
    .send({ role, email })
  expect(res.status).toBe(201)
  return res.body.data as { id: string; code: string; role: string; state: string }
}

describe("UC-08 - Lead tạo và thu hồi mã mời (Flow 9.1–9.2)", () => {
  it("tạo mã: trả mã thô đúng một lần, DB chỉ giữ hash", async () => {
    const created = await invite("analyst")

    expect(created.code).toMatch(/^[2-9A-HJKMNP-Z]+$/)
    expect(created.state).toBe("pending")

    const stored = await Invitation.findById(created.id).lean()
    expect(stored?.codeHash).toHaveLength(64)
    expect(JSON.stringify(stored)).not.toContain(created.code)

    // Danh sách cho Lead cũng không lộ mã thô
    const list = await request(app).get(ORGS + "/" + orgId + "/invitations").set(bearer(lead))
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body.data)).not.toContain(created.code)
  })

  it("không mời được với vai trò Lead - phải nâng qua UC-73", async () => {
    const res = await request(app)
      .post(ORGS + "/" + orgId + "/invitations")
      .set(bearer(lead))
      .send({ role: "lead", email: "x@flintflow.test" })
    expect(res.status).toBe(400)
  })

  it("Viewer không mời được", async () => {
    await Membership.create({ organizationId: orgId, userId: invitee.id, role: "viewer" })
    const res = await request(app)
      .post(ORGS + "/" + orgId + "/invitations")
      .set(bearer(invitee))
      .send({ role: "viewer", email: "x@flintflow.test" })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect((await request(app).get(ORGS + "/" + orgId + "/invitations").set(bearer(invitee))).status).toBe(403)
  })

  it("Analyst không tạo, xem danh sách hay thu hồi được mã mời (UC-08 chỉ Lead)", async () => {
    const analyst = await makeUser("analyst@flintflow.test")
    await Membership.create({ organizationId: orgId, userId: analyst.id, role: "analyst" })
    const created = await invite("viewer")

    const createRes = await request(app)
      .post(ORGS + "/" + orgId + "/invitations")
      .set(bearer(analyst))
      .send({ role: "viewer", email: "x@flintflow.test" })
    expect(createRes.status).toBe(403)
    expect(createRes.body.error.code).toBe("ORG_ROLE_FORBIDDEN")

    const listRes = await request(app).get(ORGS + "/" + orgId + "/invitations").set(bearer(analyst))
    expect(listRes.status).toBe(403)
    expect(listRes.body.error.code).toBe("ORG_ROLE_FORBIDDEN")

    const revokeRes = await request(app)
      .delete(ORGS + "/" + orgId + "/invitations/" + created.id)
      .set(bearer(analyst))
    expect(revokeRes.status).toBe(403)
    expect(revokeRes.body.error.code).toBe("ORG_ROLE_FORBIDDEN")

    const approveRes = await request(app)
      .post(ORGS + "/" + orgId + "/invitations/" + created.id + "/approve")
      .set(bearer(lead))
    expect(approveRes.status).toBe(404)

    const rejectRes = await request(app)
      .post(ORGS + "/" + orgId + "/invitations/" + created.id + "/reject")
      .set(bearer(lead))
    expect(rejectRes.status).toBe(404)
  })

  it("thu hồi mã chưa dùng thì mã đó hết dùng được", async () => {
    const created = await invite()

    const revoked = await request(app)
      .delete(ORGS + "/" + orgId + "/invitations/" + created.id)
      .set(bearer(lead))
    expect(revoked.status).toBe(200)
    expect(revoked.body.data.state).toBe("revoked")

    const accept = await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(invitee))
    expect(accept.status).toBe(410)
    expect(accept.body.error.code).toBe("INVITE_INVALID")
  })
})

describe("UC-09 - nhập mã mời (Flow 8.3–8.5)", () => {
  it("xem trước rồi tham gia với đúng vai trò trong mã, token mới mang orgId", async () => {
    const created = await invite("viewer")

    const preview = await request(app).get(INVITES + "/" + created.code).set(bearer(invitee))
    expect(preview.status).toBe(200)
    expect(preview.body.data).toMatchObject({ organizationName: "Org A", role: "viewer" })

    const accept = await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(invitee))
    expect(accept.status).toBe(200)
    expect(accept.body.data.organization).toMatchObject({ id: orgId, role: "viewer" })
    expect(verifyAccessToken(accept.body.data.accessToken).orgId).toBe(orgId)

    const membership = await Membership.findOne({ organizationId: orgId, userId: invitee.id }).lean()
    expect(membership?.role).toBe("viewer")
  })

  it("gõ mã chữ thường có gạch nối vẫn vào được", async () => {
    const created = await invite()
    const typed = created.code.toLowerCase().replace(/(.{4})/, "$1-")

    const accept = await request(app).post(INVITES + "/" + typed + "/accept").set(bearer(invitee))
    expect(accept.status).toBe(200)
  })

  it("Lead được báo khi có người mới vào", async () => {
    const created = await invite()
    await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(invitee))

    // Thông báo gửi kiểu bắn-rồi-quên sau khi response trả về ⇒ chờ nó được ghi, không đọc ngay
    const note = await vi.waitFor(async () => {
      const found = await Notification.findOne({ userId: lead.id, type: "org_member_joined" }).lean()
      expect(found).not.toBeNull()
      return found
    })
    expect(String(note?.organizationId)).toBe(orgId)
  })

  it("nhận mã mời cập nhật luôn Session.activeOrgId để xoay vòng refresh token giữ nguyên org mới", async () => {
    const created = await invite("analyst")
    const agent = request.agent(app)

    const loginRes = await agent
      .post("/api/v1/auth/login")
      .send({ email: invitee.email, password: "test-password-123" })
    expect(loginRes.status).toBe(200)
    expect(verifyAccessToken(loginRes.body.data.accessToken).orgId).toBeUndefined()

    const acceptRes = await agent
      .post(INVITES + "/" + created.code + "/accept")
      .set("Authorization", "Bearer " + loginRes.body.data.accessToken)
    expect(acceptRes.status).toBe(200)
    expect(verifyAccessToken(acceptRes.body.data.accessToken).orgId).toBe(orgId)

    const refreshRes = await agent.post("/api/v1/auth/refresh")
    expect(refreshRes.status).toBe(200)
    expect(verifyAccessToken(refreshRes.body.data.accessToken).orgId).toBe(orgId)
  })
})

describe("mã mời hỏng thì từ chối (Flow 8.4 nhánh No)", () => {
  it("mã không tồn tại", async () => {
    const res = await request(app).post(INVITES + "/ZZZZ999999/accept").set(bearer(invitee))
    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe("INVITE_INVALID")
  })

  it("mã hết hạn", async () => {
    const created = await invite()
    await Invitation.updateOne({ _id: created.id }, { expiresAt: new Date(Date.now() - 1000) })

    const res = await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(invitee))
    expect(res.status).toBe(410)
  })

  it("mã dùng lần thứ hai", async () => {
    const created = await invite()
    const second = await makeUser("second@flintflow.test")

    expect((await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(invitee))).status).toBe(200)

    const again = await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(second))
    expect(again.status).toBe(410)
    expect(await Membership.countDocuments({ organizationId: orgId, userId: second.id })).toBe(0)
  })

  it("hai người nhập cùng một mã đồng thời - chỉ một người vào được", async () => {
    const created = await invite()
    const other = await makeUser("other@flintflow.test")
    // Mã legacy (email: null) kiểm tra riêng tranh chấp đơn nguyên tử khi không ràng buộc email.
    await Invitation.updateOne({ _id: created.id }, { $set: { email: null } })

    const results = await Promise.all([
      request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(invitee)),
      request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(other))
    ])

    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 410)).toHaveLength(1)
    expect(await Membership.countDocuments({ organizationId: orgId })).toBe(2)
  })

  it("tài khoản khác email được mời bị chặn 403 INVITE_EMAIL_MISMATCH ở cả xem trước và chấp nhận, mã vẫn còn nguyên cho đúng người", async () => {
    const created = await invite("analyst", "invitee@flintflow.test")
    const other = await makeUser("other@flintflow.test")

    const previewRes = await request(app).get(INVITES + "/" + created.code).set(bearer(other))
    expect(previewRes.status).toBe(403)
    expect(previewRes.body.error.code).toBe("INVITE_EMAIL_MISMATCH")

    const acceptWrongRes = await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(other))
    expect(acceptWrongRes.status).toBe(403)
    expect(acceptWrongRes.body.error.code).toBe("INVITE_EMAIL_MISMATCH")
    expect(await Membership.countDocuments({ organizationId: orgId, userId: other.id })).toBe(0)

    const previewRight = await request(app).get(INVITES + "/" + created.code).set(bearer(invitee))
    expect(previewRight.status).toBe(200)

    const acceptRight = await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(invitee))
    expect(acceptRight.status).toBe(200)
    expect(await Membership.countDocuments({ organizationId: orgId, userId: invitee.id })).toBe(1)
  })

  it("mã đã hết hạn vẫn trả 410 INVITE_INVALID kể cả khi người gọi khác email", async () => {
    const created = await invite("analyst", "invitee@flintflow.test")
    const other = await makeUser("other@flintflow.test")
    await Invitation.updateOne({ _id: created.id }, { expiresAt: new Date(Date.now() - 1000) })

    const previewRes = await request(app).get(INVITES + "/" + created.code).set(bearer(other))
    expect(previewRes.status).toBe(410)
    expect(previewRes.body.error.code).toBe("INVITE_INVALID")

    const acceptRes = await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(other))
    expect(acceptRes.status).toBe(410)
    expect(acceptRes.body.error.code).toBe("INVITE_INVALID")
  })

  it("người đã là thành viên nhận 409, không phải 410", async () => {
    await Membership.create({ organizationId: orgId, userId: invitee.id, role: "analyst" })
    const created = await invite("viewer")

    const res = await request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(invitee))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("ALREADY_MEMBER")
  })

  it("chạm trần thành viên của gói free thì không mời thêm được", async () => {
    // Gói free: 3 thành viên. Lead đã chiếm 1 chỗ.
    await Membership.create({ organizationId: orgId, userId: invitee.id, role: "analyst" })
    const third = await makeUser("third@flintflow.test")
    await Membership.create({ organizationId: orgId, userId: third.id, role: "viewer" })

    const res = await request(app).post(ORGS + "/" + orgId + "/invitations").set(bearer(lead)).send({ role: "viewer", email: "x@flintflow.test" })
    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe("PLAN_LIMIT_MEMBERS")
  })

  it("org gói pro dùng trần của pro, không bị kẹt ở trần free", async () => {
    await Subscription.updateOne({ organizationId: orgId }, { $set: { plan: "pro" } })
    // 3 thành viên = trần free; pro vẫn mời được tới đủ trần pro
    await Membership.create({ organizationId: orgId, userId: invitee.id, role: "analyst" })
    const third = await makeUser("third@flintflow.test")
    await Membership.create({ organizationId: orgId, userId: third.id, role: "viewer" })
    await invite("viewer", "fourth@flintflow.test")

    for (let i = 4; i <= planConfig.pro.maxMembers; i++) {
      const extra = await makeUser(`extra${i}@flintflow.test`)
      await Membership.create({ organizationId: orgId, userId: extra.id, role: "viewer" })
    }
    const res = await request(app).post(ORGS + "/" + orgId + "/invitations").set(bearer(lead)).send({ role: "viewer", email: "y@flintflow.test" })
    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe("PLAN_LIMIT_MEMBERS")
  })
})

describe("email người được mời là bắt buộc (góp ý mentor 2026-10-02)", () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post(ORGS + "/" + orgId + "/invitations").set(bearer(lead)).send(body)

  it("thiếu email ⇒ 400, không tạo mã", async () => {
    const res = await post({ role: "analyst" })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("Hãy nhập email người được mời")
    expect(await Invitation.countDocuments({ organizationId: orgId })).toBe(0)
  })

  it("email sai định dạng hoặc chỉ toàn khoảng trắng ⇒ 400", async () => {
    expect((await post({ role: "analyst", email: "khong-phai-email" })).status).toBe(400)
    expect((await post({ role: "analyst", email: "   " })).status).toBe(400)
  })

  it("email được chuẩn hoá chữ thường, bỏ khoảng trắng hai đầu", async () => {
    const res = await post({ role: "viewer", email: "  Moi.Nguoi@FlintFlow.Test " })
    expect(res.status).toBe(201)
    expect(res.body.data.email).toBe("moi.nguoi@flintflow.test")
  })
})
