/**
 * task-26 Pha 3 — mời và tham gia tổ chức qua API thật.
 * BPMN Flow 9.1–9.2 (Lead sinh mã, gửi email, thu hồi) và Flow 8.3–8.5 (nhập mã, kiểm mã, vào org).
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { Invitation } from "../../src/modules/organization/invitation.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
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

const invite = async (role = "analyst", email?: string) => {
  const res = await request(app)
    .post(ORGS + "/" + orgId + "/invitations")
    .set(bearer(lead))
    .send({ role, ...(email ? { email } : {}) })
  expect(res.status).toBe(201)
  return res.body.data as { id: string; code: string; role: string; state: string }
}

describe("UC-08 — Lead tạo và thu hồi mã mời (Flow 9.1–9.2)", () => {
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

  it("không mời được với vai trò Lead — phải nâng qua UC-73", async () => {
    const res = await request(app)
      .post(ORGS + "/" + orgId + "/invitations")
      .set(bearer(lead))
      .send({ role: "lead" })
    expect(res.status).toBe(400)
  })

  it("chỉ Lead mới tạo được mã", async () => {
    await Membership.create({ organizationId: orgId, userId: invitee.id, role: "analyst" })
    const res = await request(app)
      .post(ORGS + "/" + orgId + "/invitations")
      .set(bearer(invitee))
      .send({ role: "viewer" })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
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

describe("UC-09 — nhập mã mời (Flow 8.3–8.5)", () => {
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

    const note = await Notification.findOne({ userId: lead.id, type: "org_member_joined" }).lean()
    expect(note).not.toBeNull()
    expect(String(note?.organizationId)).toBe(orgId)
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

  it("hai người nhập cùng một mã đồng thời — chỉ một người vào được", async () => {
    const created = await invite()
    const other = await makeUser("other@flintflow.test")

    const results = await Promise.all([
      request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(invitee)),
      request(app).post(INVITES + "/" + created.code + "/accept").set(bearer(other))
    ])

    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 410)).toHaveLength(1)
    expect(await Membership.countDocuments({ organizationId: orgId })).toBe(2)
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

    const res = await request(app).post(ORGS + "/" + orgId + "/invitations").set(bearer(lead)).send({ role: "viewer" })
    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe("PLAN_LIMIT_MEMBERS")
  })
})
