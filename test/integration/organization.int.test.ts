/**
 * task-26 Pha 2 — CRUD org + thành viên + BR-02, gọi qua API thật (supertest + app).
 * Bám BPMN Flow 8.1–8.2 (tạo org), Flow 9.3–9.9 (đổi org, đổi vai trò, xoá, rời, BR-02).
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Organization } from "../../src/modules/organization/organization.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { Session } from "../../src/shared/auth/session.model.js"
import { authAs } from "../setup.js"
import { verifyAccessToken } from "../../src/shared/auth/jwt.util.js"

const API = "/api/v1/orgs"

interface Actor {
  id: string
  email: string
  token: string
}

const makeUser = async (email: string, name: string): Promise<Actor> => {
  const user = await User.create({ email, password: "test-password-123", name, emailVerified: true })
  return { id: String(user._id), email, token: await authAs({ _id: user._id, email }) }
}

let lead: Actor
let analyst: Actor

beforeEach(async () => {
  lead = await makeUser("lead@flintflow.test", "Lanh dao")
  analyst = await makeUser("analyst@flintflow.test", "Phan tich")
})

const bearer = (actor: Actor) => ({ Authorization: "Bearer " + actor.token })

const createOrg = async (actor: Actor, name = "Org A") => {
  const res = await request(app).post(API).set(bearer(actor)).send({ name })
  expect(res.status).toBe(201)
  return res.body.data as { id: string; name: string; role: string }
}

const addMember = async (orgId: string, actor: Actor, role: OrgRole) => {
  await Membership.create({ organizationId: orgId, userId: actor.id, role })
}

const loginAs = async (actor: Actor) => {
  const agent = request.agent(app)
  const res = await agent
    .post("/api/v1/auth/login")
    .send({ email: actor.email, password: "test-password-123" })
  expect(res.status).toBe(200)
  return { agent, accessToken: res.body.data.accessToken as string }
}

describe("Organization API (Pha 2)", () => {
  it("UC-07 / Flow 8.2 - tạo org thì người tạo thành Lead đầu tiên", async () => {
    const org = await createOrg(lead)

    expect(org.name).toBe("Org A")
    expect(org.role).toBe("lead")
    const membership = await Membership.findOne({ organizationId: org.id, userId: lead.id }).lean()
    expect(membership?.role).toBe("lead")
    const stored = await Organization.findById(org.id).lean()
    expect(String(stored?.ownerUserId)).toBe(lead.id)
  })

  it("tên rỗng bị chặn ở validation", async () => {
    const res = await request(app).post(API).set(bearer(lead)).send({ name: "   " })
    expect(res.status).toBe(400)
  })

  it("UC-10 - danh sách org của tôi kèm vai trò từng nơi", async () => {
    const a = await createOrg(lead, "Org A")
    const b = await createOrg(lead, "Org B")
    await addMember(b.id, analyst, "viewer")

    const res = await request(app).get(API).set(bearer(analyst))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ id: b.id, role: "viewer" })

    const mine = await request(app).get(API).set(bearer(lead))
    expect(mine.body.data.map((o: { id: string }) => o.id).sort()).toEqual([a.id, b.id].sort())
  })

  it("org của người khác trả 404, không lộ sự tồn tại", async () => {
    const org = await createOrg(lead)
    const res = await request(app).get(API + "/" + org.id).set(bearer(analyst))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("ORG_NOT_FOUND")
  })

  it("UC-10 / Flow 9.3 - switch trả access token mới mang orgId", async () => {
    const org = await createOrg(lead)
    const res = await request(app).post(API + "/" + org.id + "/switch").set(bearer(lead))

    expect(res.status).toBe(200)
    expect(verifyAccessToken(res.body.data.accessToken).orgId).toBe(org.id)
    expect(res.body.data.organization).toMatchObject({ id: org.id, role: "lead" })
  })

  it("đổi tên org: Lead được, Analyst bị 403", async () => {
    const org = await createOrg(lead)
    await addMember(org.id, analyst, "analyst")

    const denied = await request(app).patch(API + "/" + org.id).set(bearer(analyst)).send({ name: "Ten moi" })
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe("ORG_ROLE_FORBIDDEN")

    const ok = await request(app).patch(API + "/" + org.id).set(bearer(lead)).send({ name: "Ten moi" })
    expect(ok.status).toBe(200)
    expect(ok.body.data.name).toBe("Ten moi")
  })

  it("UC-73 / Flow 9.5 - Lead đổi vai trò thành viên và người đó được báo", async () => {
    const org = await createOrg(lead)
    await addMember(org.id, analyst, "viewer")

    const res = await request(app)
      .patch(API + "/" + org.id + "/members/" + analyst.id + "/role")
      .set(bearer(lead))
      .send({ role: "analyst" })

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ userId: analyst.id, role: "analyst" })

    // Thông báo gửi kiểu bắn-rồi-quên sau khi response trả về ⇒ chờ nó được ghi, không đọc ngay
    const note = await vi.waitFor(async () => {
      const found = await Notification.findOne({ userId: analyst.id, type: "org_role_changed" }).lean()
      expect(found).not.toBeNull()
      return found
    })
    expect(String(note?.organizationId)).toBe(org.id)
  })

  it("UC-74 / Flow 9.6 - Lead xoá thành viên", async () => {
    const org = await createOrg(lead)
    await addMember(org.id, analyst, "analyst")

    const res = await request(app).delete(API + "/" + org.id + "/members/" + analyst.id).set(bearer(lead))
    expect(res.status).toBe(200)
    expect(await Membership.countDocuments({ organizationId: org.id, userId: analyst.id })).toBe(0)
  })

  it("UC-72 / Flow 9.7 - thành viên tự rời, Lead được báo", async () => {
    const org = await createOrg(lead)
    await addMember(org.id, analyst, "analyst")

    const res = await request(app).delete(API + "/" + org.id + "/members/me").set(bearer(analyst))
    expect(res.status).toBe(200)
    expect(await Membership.countDocuments({ organizationId: org.id, userId: analyst.id })).toBe(0)

    // Thông báo gửi kiểu bắn-rồi-quên sau khi response trả về ⇒ chờ nó được ghi, không đọc ngay
    const note = await vi.waitFor(async () => {
      const found = await Notification.findOne({ userId: lead.id, type: "org_member_left" }).lean()
      expect(found).not.toBeNull()
      return found
    })
  })

  it("UC-15 / UC-74 - xoá thành viên gỡ Session.activeOrgId và /auth/refresh cấp token không còn orgId cũ", async () => {
    const org = await createOrg(lead)
    await addMember(org.id, analyst, "analyst")
    const { agent, accessToken } = await loginAs(analyst)

    expect(verifyAccessToken(accessToken).orgId).toBe(org.id)
    const beforeSession = await Session.findOne({ userId: analyst.id, isRevoked: false }).lean()
    expect(String(beforeSession?.activeOrgId)).toBe(org.id)

    const removeRes = await request(app).delete(API + "/" + org.id + "/members/" + analyst.id).set(bearer(lead))
    expect(removeRes.status).toBe(200)
    expect(await Session.countDocuments({ userId: analyst.id, activeOrgId: org.id })).toBe(0)

    const afterRemoveSession = await Session.findOne({ userId: analyst.id, isRevoked: false }).lean()
    expect(afterRemoveSession).not.toBeNull()
    expect(afterRemoveSession?.activeOrgId).toBeNull()

    const projectRes = await request(app)
      .get("/api/v1/projects")
      .set("Authorization", "Bearer " + accessToken)
    expect(projectRes.status).toBe(403)
    expect(projectRes.body.error.code).toBe("ORG_FORBIDDEN")

    const refreshRes = await agent.post("/api/v1/auth/refresh")
    expect(refreshRes.status).toBe(200)
    const refreshedToken = refreshRes.body.data.accessToken as string
    expect(verifyAccessToken(refreshedToken).orgId).toBeUndefined()

    const rotatedSession = await Session.findOne({ userId: analyst.id, isRevoked: false }).lean()
    expect(rotatedSession).not.toBeNull()
    expect(rotatedSession?.activeOrgId).toBeNull()

    const afterRefreshProjects = await request(app)
      .get("/api/v1/projects")
      .set("Authorization", "Bearer " + refreshedToken)
    expect(afterRefreshProjects.status).toBe(409)
    expect(afterRefreshProjects.body.error.code).toBe("NO_ACTIVE_ORG")
  })

  it("UC-13 / UC-72 - thành viên tự rời gỡ Session.activeOrgId và /auth/refresh không còn orgId cũ", async () => {
    const org = await createOrg(lead)
    await addMember(org.id, analyst, "analyst")
    const { agent, accessToken } = await loginAs(analyst)

    expect(verifyAccessToken(accessToken).orgId).toBe(org.id)

    const leaveRes = await request(app).delete(API + "/" + org.id + "/members/me").set(bearer(analyst))
    expect(leaveRes.status).toBe(200)
    expect(await Session.countDocuments({ userId: analyst.id, activeOrgId: org.id })).toBe(0)

    const afterLeaveSession = await Session.findOne({ userId: analyst.id, isRevoked: false }).lean()
    expect(afterLeaveSession).not.toBeNull()
    expect(afterLeaveSession?.activeOrgId).toBeNull()

    const refreshRes = await agent.post("/api/v1/auth/refresh")
    expect(refreshRes.status).toBe(200)
    expect(verifyAccessToken(refreshRes.body.data.accessToken).orgId).toBeUndefined()

    const rotatedSession = await Session.findOne({ userId: analyst.id, isRevoked: false }).lean()
    expect(rotatedSession).not.toBeNull()
    expect(rotatedSession?.activeOrgId).toBeNull()
  })

  it("phòng thủ race condition: /auth/refresh lọc bỏ orgId nếu Session còn activeOrgId nhưng Membership đã bị xoá", async () => {
    const org = await createOrg(lead)
    await addMember(org.id, analyst, "analyst")
    const { agent, accessToken } = await loginAs(analyst)
    expect(verifyAccessToken(accessToken).orgId).toBe(org.id)

    await Membership.deleteOne({ organizationId: org.id, userId: analyst.id })
    const staleSession = await Session.findOne({ userId: analyst.id, isRevoked: false }).lean()
    expect(String(staleSession?.activeOrgId)).toBe(org.id)

    const refreshRes = await agent.post("/api/v1/auth/refresh")
    expect(refreshRes.status).toBe(200)
    expect(verifyAccessToken(refreshRes.body.data.accessToken).orgId).toBeUndefined()

    const rotatedSession = await Session.findOne({ userId: analyst.id, isRevoked: false }).lean()
    expect(rotatedSession).not.toBeNull()
    expect(rotatedSession?.activeOrgId).toBeNull()
  })

  it("xoá thành viên chỉ gỡ Session.activeOrgId của đúng user + đúng org, và lỗi BR-02 không xoá session", async () => {
    const orgA = await createOrg(lead, "Org A")
    const orgB = await createOrg(lead, "Org B")
    await addMember(orgA.id, analyst, "analyst")
    await addMember(orgB.id, analyst, "analyst")

    const leadLogin = await loginAs(lead)
    const leadSwitch = await leadLogin.agent
      .post(API + "/" + orgA.id + "/switch")
      .set("Authorization", "Bearer " + leadLogin.accessToken)
    expect(leadSwitch.status).toBe(200)

    const sessionA = await loginAs(analyst)
    const switchA = await sessionA.agent
      .post(API + "/" + orgA.id + "/switch")
      .set("Authorization", "Bearer " + sessionA.accessToken)
    expect(switchA.status).toBe(200)

    const sessionB = await loginAs(analyst)
    const switchB = await sessionB.agent
      .post(API + "/" + orgB.id + "/switch")
      .set("Authorization", "Bearer " + sessionB.accessToken)
    expect(switchB.status).toBe(200)

    // Thất bại LAST_LEAD không được đụng Session.activeOrgId của Lead
    const lastLeadRes = await request(app).delete(API + "/" + orgA.id + "/members/me").set(bearer(lead))
    expect(lastLeadRes.status).toBe(409)
    expect(await Session.countDocuments({ userId: lead.id, activeOrgId: orgA.id, isRevoked: false })).toBe(1)

    // Xoá analyst khỏi orgA: chỉ phiên đang mở orgA của analyst bị gỡ
    const removeRes = await request(app).delete(API + "/" + orgA.id + "/members/" + analyst.id).set(bearer(lead))
    expect(removeRes.status).toBe(200)
    expect(await Session.countDocuments({ userId: analyst.id, activeOrgId: orgA.id, isRevoked: false })).toBe(0)
    expect(await Session.countDocuments({ userId: analyst.id, activeOrgId: orgB.id, isRevoked: false })).toBe(1)
    expect(await Session.countDocuments({ userId: lead.id, activeOrgId: orgA.id, isRevoked: false })).toBe(1)

    // Thất bại MEMBER_NOT_FOUND không làm hỏng phiên đang mở org khác
    const missingRes = await request(app).delete(API + "/" + orgA.id + "/members/" + analyst.id).set(bearer(lead))
    expect(missingRes.status).toBe(404)
    expect(missingRes.body.error.code).toBe("MEMBER_NOT_FOUND")
    expect(await Session.countDocuments({ userId: analyst.id, activeOrgId: orgB.id, isRevoked: false })).toBe(1)

    // Phiên mở orgB vẫn giữ nguyên orgB qua lượt /auth/refresh vì Membership ở orgB còn hiệu lực
    const refreshB = await sessionB.agent.post("/api/v1/auth/refresh")
    expect(refreshB.status).toBe(200)
    expect(verifyAccessToken(refreshB.body.data.accessToken).orgId).toBe(orgB.id)
    expect(await Session.countDocuments({ userId: analyst.id, activeOrgId: orgB.id, isRevoked: false })).toBe(1)
  })
})

describe("BR-02 Lead succession (Flow 9.8)", () => {
  it("Lead duy nhất không rời được", async () => {
    const org = await createOrg(lead)
    const res = await request(app).delete(API + "/" + org.id + "/members/me").set(bearer(lead))

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("LAST_LEAD")
    expect(await Membership.countDocuments({ organizationId: org.id, role: "lead" })).toBe(1)
  })

  it("Lead duy nhất không bị hạ vai trò", async () => {
    const org = await createOrg(lead)
    const res = await request(app)
      .patch(API + "/" + org.id + "/members/" + lead.id + "/role")
      .set(bearer(lead))
      .send({ role: "viewer" })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("LAST_LEAD")
  })

  it("Lead duy nhất không bị xoá", async () => {
    const org = await createOrg(lead)
    const res = await request(app).delete(API + "/" + org.id + "/members/" + lead.id).set(bearer(lead))

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("LAST_LEAD")
  })

  it("có Lead thứ hai thì Lead đầu rời được", async () => {
    const org = await createOrg(lead)
    await addMember(org.id, analyst, "lead")

    const res = await request(app).delete(API + "/" + org.id + "/members/me").set(bearer(lead))
    expect(res.status).toBe(200)
    expect(await Membership.countDocuments({ organizationId: org.id, role: "lead" })).toBe(1)
  })

  it("hai request hạ hai Lead cuối cùng chạy song song - org vẫn còn Lead", async () => {
    const org = await createOrg(lead)
    await addMember(org.id, analyst, "lead")

    const demote = (target: Actor) =>
      request(app)
        .patch(API + "/" + org.id + "/members/" + target.id + "/role")
        .set(bearer(lead))
        .send({ role: "viewer" })

    const results = await Promise.all([demote(lead), demote(analyst)])

    expect(await Membership.countDocuments({ organizationId: org.id, role: "lead" })).toBe(1)
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(1)
  })
})
