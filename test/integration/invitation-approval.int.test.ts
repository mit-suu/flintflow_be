/**
 * FLF-303 — Analyst gửi yêu cầu mời, Lead duyệt / từ chối.
 * Chưa duyệt thì không có email, không có mã thô; duyệt mới sinh mã + gửi email; trần thành viên kiểm lúc duyệt.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import request from "supertest"

const sent = vi.hoisted(() => [] as { to: string; code: string }[])
vi.mock("../../src/shared/email/email.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/email/email.service.js")>()),
  sendOrgInvitationEmail: vi.fn(async (to: string, input: { code: string }) => {
    sent.push({ to, code: input.code })
  })
}))

import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { Invitation } from "../../src/modules/organization/invitation.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { authAs } from "../setup.js"

const ORGS = "/api/v1/orgs"
const INVITES = "/api/v1/invitations"

interface Actor {
  id: string
  email: string
  token: string
}

const makeUser = async (email: string, name = email): Promise<Actor> => {
  const user = await User.create({ email, password: "test-password-123", name, emailVerified: true })
  return { id: String(user._id), email, token: await authAs({ _id: user._id, email }) }
}

const bearer = (actor: Actor) => ({ Authorization: "Bearer " + actor.token })

let lead: Actor
let analyst: Actor
let invitee: Actor
let orgId: string

beforeEach(async () => {
  sent.length = 0
  lead = await makeUser("lead@flintflow.test")
  analyst = await makeUser("analyst@flintflow.test", "An Analyst")
  invitee = await makeUser("invitee@flintflow.test")
  const res = await request(app).post(ORGS).set(bearer(lead)).send({ name: "Org A" })
  orgId = res.body.data.id
  await Membership.create({ organizationId: orgId, userId: analyst.id, role: "analyst" })
})

const invitations = (path = "") => ORGS + "/" + orgId + "/invitations" + path

const requestInvite = async (role = "viewer", email = "invitee@flintflow.test") => {
  const res = await request(app).post(invitations()).set(bearer(analyst)).send({ role, email })
  expect(res.status).toBe(201)
  return res.body.data as { id: string; state: string; code?: string; requestedBy: { id: string; name: string } }
}

describe("Analyst gửi yêu cầu mời", () => {
  it("tạo yêu cầu chờ duyệt: không mã thô, không email, mã giữ chỗ không dùng được", async () => {
    const created = await requestInvite()

    expect(created.state).toBe("awaiting_approval")
    expect(created.code).toBeUndefined()
    expect(created.requestedBy).toEqual({ id: analyst.id, name: "An Analyst" })
    expect(sent).toHaveLength(0)

    const stored = await Invitation.findById(created.id).lean()
    expect(String(stored?.requestedByUserId)).toBe(analyst.id)
    expect(stored?.approvedAt).toBeNull()
  })

  it("mọi Lead được báo có yêu cầu chờ duyệt", async () => {
    const created = await requestInvite()
    const note = await vi.waitFor(async () => {
      const found = await Notification.findOne({ userId: lead.id, type: "org_invitation_requested" }).lean()
      expect(found).not.toBeNull()
      return found
    })
    expect(note?.meta).toMatchObject({ invitationId: created.id })
    expect(note?.link).toBe("/home/members")
  })

  it("không kiểm trần thành viên lúc gửi yêu cầu", async () => {
    // Gói free: 3 thành viên — Lead + Analyst + một người nữa là đầy
    const third = await makeUser("third@flintflow.test")
    await Membership.create({ organizationId: orgId, userId: third.id, role: "viewer" })
    await requestInvite()
  })

  it("Analyst chỉ thấy lời mời của chính mình; Lead thấy tất cả", async () => {
    const mine = await requestInvite()
    const leadInvite = await request(app).post(invitations()).set(bearer(lead)).send({ role: "viewer", email: "x@flintflow.test" })
    expect(leadInvite.status).toBe(201)

    const analystList = await request(app).get(invitations()).set(bearer(analyst))
    expect(analystList.status).toBe(200)
    expect(analystList.body.data.map((i: { id: string }) => i.id)).toEqual([mine.id])

    const leadList = await request(app).get(invitations()).set(bearer(lead))
    expect(leadList.body.data).toHaveLength(2)
    expect(JSON.stringify(leadList.body.data)).not.toContain(leadInvite.body.data.code)
  })
})

describe("Lead duyệt yêu cầu", () => {
  it("duyệt ⇒ sinh mã, gửi email đúng địa chỉ, người được mời vào được", async () => {
    const created = await requestInvite("analyst")

    const approved = await request(app).post(invitations("/" + created.id + "/approve")).set(bearer(lead))
    expect(approved.status).toBe(200)
    expect(approved.body.data.state).toBe("pending")
    expect(approved.body.data.code).toMatch(/^[2-9A-HJKMNP-Z]+$/)
    expect(sent).toEqual([{ to: "invitee@flintflow.test", code: approved.body.data.code }])

    const accept = await request(app).post(INVITES + "/" + approved.body.data.code + "/accept").set(bearer(invitee))
    expect(accept.status).toBe(200)
    expect(accept.body.data.organization).toMatchObject({ id: orgId, role: "analyst" })
  })

  it("người yêu cầu được báo khi được duyệt", async () => {
    const created = await requestInvite()
    await request(app).post(invitations("/" + created.id + "/approve")).set(bearer(lead))
    await vi.waitFor(async () => {
      expect(await Notification.exists({ userId: analyst.id, type: "org_invitation_approved" })).not.toBeNull()
    })
  })

  it("duyệt hai lần ⇒ lần sau 409, chỉ một email", async () => {
    const created = await requestInvite()
    expect((await request(app).post(invitations("/" + created.id + "/approve")).set(bearer(lead))).status).toBe(200)

    const again = await request(app).post(invitations("/" + created.id + "/approve")).set(bearer(lead))
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("INVITE_NOT_AWAITING_APPROVAL")
    expect(sent).toHaveLength(1)
  })

  it("lời mời Lead tạo thẳng không có gì để duyệt", async () => {
    const direct = await request(app).post(invitations()).set(bearer(lead)).send({ role: "viewer", email: "x@flintflow.test" })
    const res = await request(app).post(invitations("/" + direct.body.data.id + "/approve")).set(bearer(lead))
    expect(res.status).toBe(409)
  })

  it("trần thành viên kiểm lúc duyệt", async () => {
    const created = await requestInvite()
    const third = await makeUser("third@flintflow.test")
    await Membership.create({ organizationId: orgId, userId: third.id, role: "viewer" })

    const res = await request(app).post(invitations("/" + created.id + "/approve")).set(bearer(lead))
    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe("PLAN_LIMIT_MEMBERS")
    expect(sent).toHaveLength(0)
    expect((await Invitation.findById(created.id).lean())?.approvedAt).toBeNull()
  })

  it("Analyst không tự duyệt / từ chối được", async () => {
    const created = await requestInvite()
    for (const action of ["/approve", "/reject"]) {
      const res = await request(app).post(invitations("/" + created.id + action)).set(bearer(analyst))
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    }
    expect(sent).toHaveLength(0)
  })
})

describe("Lead từ chối yêu cầu", () => {
  it("từ chối ⇒ lời mời đóng, không email, người yêu cầu được báo, không duyệt lại được", async () => {
    const created = await requestInvite()

    const rejected = await request(app).post(invitations("/" + created.id + "/reject")).set(bearer(lead))
    expect(rejected.status).toBe(200)
    expect(rejected.body.data.state).toBe("rejected")
    expect(sent).toHaveLength(0)

    await vi.waitFor(async () => {
      expect(await Notification.exists({ userId: analyst.id, type: "org_invitation_rejected" })).not.toBeNull()
    })

    const approve = await request(app).post(invitations("/" + created.id + "/approve")).set(bearer(lead))
    expect(approve.status).toBe(409)
  })
})

describe("Analyst huỷ yêu cầu của mình", () => {
  it("còn chờ duyệt thì huỷ được", async () => {
    const created = await requestInvite()
    const res = await request(app).delete(invitations("/" + created.id)).set(bearer(analyst))
    expect(res.status).toBe(200)
    expect(res.body.data.state).toBe("revoked")
  })

  it("đã duyệt thì chỉ Lead thu hồi", async () => {
    const created = await requestInvite()
    await request(app).post(invitations("/" + created.id + "/approve")).set(bearer(lead))

    const byAnalyst = await request(app).delete(invitations("/" + created.id)).set(bearer(analyst))
    expect(byAnalyst.status).toBe(403)

    const byLead = await request(app).delete(invitations("/" + created.id)).set(bearer(lead))
    expect(byLead.status).toBe(200)
    expect(byLead.body.data.state).toBe("revoked")
  })

  it("không đụng được lời mời của người khác", async () => {
    const direct = await request(app).post(invitations()).set(bearer(lead)).send({ role: "viewer", email: "x@flintflow.test" })
    const res = await request(app).delete(invitations("/" + direct.body.data.id)).set(bearer(analyst))
    expect(res.status).toBe(404)
  })
})
