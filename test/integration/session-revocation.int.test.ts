import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import crypto from "node:crypto"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Session } from "../../src/shared/auth/session.model.js"
import { Organization } from "../../src/modules/organization/organization.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { verifyAccessToken, hashToken } from "../../src/shared/auth/jwt.util.js"
import { AuthToken } from "../../src/modules/auth/auth-token.model.js"

describe("Session Revocation & Organization Default Context", () => {
  it("Scenario 1: login trả activeOrgId, organizations, needsOnboarding và sid khớp Session; logout thu hồi phiên ngay lập tức", async () => {
    const user = await User.create({
      email: "scenario1@flintflow.test",
      password: "Password123!",
      emailVerified: true
    })
    const agent = request.agent(app)
    const loginRes = await agent.post("/api/v1/auth/login").send({
      email: "scenario1@flintflow.test",
      password: "Password123!"
    })

    expect(loginRes.status).toBe(200)
    expect(loginRes.body.data).toHaveProperty("activeOrgId")
    expect(loginRes.body.data).toHaveProperty("organizations")
    expect(loginRes.body.data).toHaveProperty("needsOnboarding")
    expect(loginRes.body.data.needsOnboarding).toBe(true)

    const accessToken = loginRes.body.data.accessToken
    const decoded = verifyAccessToken(accessToken)
    expect(decoded.sid).toBeDefined()

    const session = await Session.findById(decoded.sid)
    expect(session).not.toBeNull()
    expect(session?.isRevoked).toBe(false)
    expect(String(session?.userId)).toBe(String(user._id))

    // Logout
    const logoutRes = await agent.post("/api/v1/auth/logout")
    expect(logoutRes.status).toBe(200)

    // Call GET /api/v1/users/me using the old accessToken
    const meRes = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${accessToken}`)
    expect(meRes.status).toBe(401)
    expect(meRes.body.error.code).toBe("SESSION_REVOKED")

    // Call GET /api/v1/orgs using the old accessToken
    const orgsRes = await request(app)
      .get("/api/v1/orgs")
      .set("Authorization", `Bearer ${accessToken}`)
    expect(orgsRes.status).toBe(401)
    expect(orgsRes.body.error.code).toBe("SESSION_REVOKED")
  })

  it("Scenario 2: đăng nhập 2 thiết bị, switch org ở thiết bị A, logout-all từ thiết bị A ⇒ cả 2 thiết bị bị chặn 401 SESSION_REVOKED ngay lập tức", async () => {
    const user = await User.create({
      email: "scenario2@flintflow.test",
      password: "Password123!",
      emailVerified: true
    })
    const org = await Organization.create({ name: "Org 2", ownerUserId: user._id })
    await Membership.create({ organizationId: org._id, userId: user._id, role: "lead" })

    const agentA = request.agent(app)
    const resA = await agentA.post("/api/v1/auth/login").send({
      email: "scenario2@flintflow.test",
      password: "Password123!"
    })
    const tokenA = resA.body.data.accessToken

    const agentB = request.agent(app)
    const resB = await agentB.post("/api/v1/auth/login").send({
      email: "scenario2@flintflow.test",
      password: "Password123!"
    })
    const tokenB = resB.body.data.accessToken

    // Device A switches org
    const switchRes = await agentA
      .post(`/api/v1/orgs/${org._id}/switch`)
      .set("Authorization", `Bearer ${tokenA}`)
    expect(switchRes.status).toBe(200)
    const tokenASwitched = switchRes.body.data.accessToken
    expect(verifyAccessToken(tokenASwitched).sid).toBe(verifyAccessToken(tokenA).sid)

    // Device A calls logout-all
    const logoutAllRes = await agentA
      .post("/api/v1/auth/logout-all")
      .set("Authorization", `Bearer ${tokenASwitched}`)
    expect(logoutAllRes.status).toBe(200)

    // tokenASwitched and tokenB are blocked immediately on GET /users/me
    const meARes = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${tokenASwitched}`)
    expect(meARes.status).toBe(401)
    expect(meARes.body.error.code).toBe("SESSION_REVOKED")

    const meBRes = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${tokenB}`)
    expect(meBRes.status).toBe(401)
    expect(meBRes.body.error.code).toBe("SESSION_REVOKED")

    // Calling logout-all again with tokenB is also blocked
    const logoutAllBRes = await request(app)
      .post("/api/v1/auth/logout-all")
      .set("Authorization", `Bearer ${tokenB}`)
    expect(logoutAllBRes.status).toBe(401)
    expect(logoutAllBRes.body.error.code).toBe("SESSION_REVOKED")
  })

  it("Scenario 3 (UC-05): POST /users/me/password giữ phiên hiện tại (có cookie hoặc chỉ có Bearer), thu hồi phiên khác", async () => {
    const user = await User.create({
      email: "scenario3@flintflow.test",
      password: "OldPassword123!",
      emailVerified: true
    })

    // Part 1: with refreshToken cookie
    const agentA = request.agent(app)
    const resA = await agentA.post("/api/v1/auth/login").send({
      email: "scenario3@flintflow.test",
      password: "OldPassword123!"
    })
    const tokenA = resA.body.data.accessToken

    const agentB = request.agent(app)
    const resB = await agentB.post("/api/v1/auth/login").send({
      email: "scenario3@flintflow.test",
      password: "OldPassword123!"
    })
    const tokenB = resB.body.data.accessToken

    const changePwRes = await agentA
      .post("/api/v1/users/me/password")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ currentPassword: "OldPassword123!", newPassword: "NewPassword123!" })
    expect(changePwRes.status).toBe(200)

    const meARes = await agentA
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${tokenA}`)
    expect(meARes.status).toBe(200)

    const meBRes = await agentB
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${tokenB}`)
    expect(meBRes.status).toBe(401)
    expect(meBRes.body.error.code).toBe("SESSION_REVOKED")

    // Part 2: Pure Bearer token without cookie keeps the active session alive
    const agentC = request.agent(app)
    const resC = await agentC.post("/api/v1/auth/login").send({
      email: "scenario3@flintflow.test",
      password: "NewPassword123!"
    })
    const tokenC = resC.body.data.accessToken

    const agentD = request.agent(app)
    const resD = await agentD.post("/api/v1/auth/login").send({
      email: "scenario3@flintflow.test",
      password: "NewPassword123!"
    })
    const tokenD = resD.body.data.accessToken

    // Device C calls changePassword with only Authorization header (no cookies)
    const changePwNoCookie = await request(app)
      .post("/api/v1/users/me/password")
      .set("Authorization", `Bearer ${tokenC}`)
      .send({ currentPassword: "NewPassword123!", newPassword: "FinalPassword123!" })
    expect(changePwNoCookie.status).toBe(200)

    const meCRes = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${tokenC}`)
    expect(meCRes.status).toBe(200)

    const meDRes = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${tokenD}`)
    expect(meDRes.status).toBe(401)
    expect(meDRes.body.error.code).toBe("SESSION_REVOKED")
  })

  it("Scenario 4 (UC-04): reset-password thu hồi mọi phiên trước đó ngay lập tức", async () => {
    const user = await User.create({
      email: "scenario4@flintflow.test",
      password: "Password123!",
      emailVerified: true
    })
    const loginRes = await request(app).post("/api/v1/auth/login").send({
      email: "scenario4@flintflow.test",
      password: "Password123!"
    })
    const token = loginRes.body.data.accessToken

    // Create reset_password_grant directly in DB
    const resetToken = crypto.randomBytes(32).toString("hex")
    await AuthToken.create({
      userId: user._id,
      type: "reset_password_grant",
      tokenHash: hashToken(resetToken),
      expiresAt: new Date(Date.now() + 600000)
    })

    const resetRes = await request(app).post("/api/v1/auth/reset-password").send({
      resetToken,
      password: "ResetNewPassword123!"
    })
    expect(resetRes.status).toBe(200)

    // Old token is immediately revoked
    const meRes = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${token}`)
    expect(meRes.status).toBe(401)
    expect(meRes.body.error.code).toBe("SESSION_REVOKED")
  })

  it("Scenario 5: Admin logout ⇒ access token cũ bị chặn 401 SESSION_REVOKED ở GET /admin/metrics", async () => {
    await User.create({
      email: "admin5@flintflow.test",
      password: "AdminPassword123!",
      role: "admin",
      emailVerified: true
    })

    const agent = request.agent(app)
    const loginRes = await agent.post("/api/v1/auth/login").send({
      email: "admin5@flintflow.test",
      password: "AdminPassword123!"
    })
    const adminToken = loginRes.body.data.accessToken

    const metricsBefore = await agent
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(metricsBefore.status).toBe(200)

    const logoutRes = await agent.post("/api/v1/auth/logout")
    expect(logoutRes.status).toBe(200)

    const metricsAfter = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(metricsAfter.status).toBe(401)
    expect(metricsAfter.body.error.code).toBe("SESSION_REVOKED")
  })

  it("Scenario 6: Khi phiên đã bị thu hồi, POST /auth/refresh trả 401 và xoá cookie refreshToken + accessToken", async () => {
    await User.create({
      email: "scenario6@flintflow.test",
      password: "Password123!",
      emailVerified: true
    })

    const agent = request.agent(app)
    const loginRes = await agent.post("/api/v1/auth/login").send({
      email: "scenario6@flintflow.test",
      password: "Password123!"
    })
    expect(loginRes.status).toBe(200)

    // Revoke all sessions in DB
    await Session.updateMany({}, { isRevoked: true })

    const refreshRes = await agent.post("/api/v1/auth/refresh")
    expect(refreshRes.status).toBe(401)

    const setCookies = refreshRes.headers["set-cookie"] as unknown as string[] | undefined
    expect(setCookies).toBeDefined()
    const rtCookie = setCookies?.find((c) => c.startsWith("refreshToken="))
    const atCookie = setCookies?.find((c) => c.startsWith("accessToken="))
    expect(rtCookie).toBeDefined()
    expect(atCookie).toBeDefined()
    expect(rtCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
    expect(atCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  })

  it("Scenario 7: Ghi nhớ tổ chức mặc định & fallback khi mất quyền (bị xoá khỏi org)", async () => {
    const user = await User.create({
      email: "scenario7@flintflow.test",
      password: "Password123!",
      emailVerified: true
    })

    const lead = await User.create({
      email: "lead7@flintflow.test",
      password: "Password123!",
      emailVerified: true
    })

    const orgA = await Organization.create({ name: "Org A", ownerUserId: lead._id })
    const orgB = await Organization.create({ name: "Org B", ownerUserId: lead._id })
    const orgC = await Organization.create({ name: "Org C", ownerUserId: lead._id })

    await Membership.create([
      { organizationId: orgA._id, userId: lead._id, role: "lead" },
      { organizationId: orgB._id, userId: lead._id, role: "lead" },
      { organizationId: orgC._id, userId: lead._id, role: "lead" },
      { organizationId: orgA._id, userId: user._id, role: "analyst" },
      { organizationId: orgB._id, userId: user._id, role: "analyst" },
      { organizationId: orgC._id, userId: user._id, role: "analyst" }
    ])

    // Login 1st time: 3 orgs, no default -> activeOrgId: null
    const login1 = await request(app).post("/api/v1/auth/login").send({
      email: "scenario7@flintflow.test",
      password: "Password123!"
    })
    expect(login1.status).toBe(200)
    expect(login1.body.data.activeOrgId).toBeNull()
    expect(login1.body.data.organizations).toHaveLength(3)

    const token1 = login1.body.data.accessToken

    // Switch to Org A with rememberAsDefault: true
    const switchRes = await request(app)
      .post(`/api/v1/orgs/${orgA._id}/switch`)
      .set("Authorization", `Bearer ${token1}`)
      .send({ rememberAsDefault: true })
    expect(switchRes.status).toBe(200)
    expect(switchRes.body.data.organization.isDefault).toBe(true)

    // GET /orgs shows isDefault: true on Org A
    const orgsRes = await request(app)
      .get("/api/v1/orgs")
      .set("Authorization", `Bearer ${switchRes.body.data.accessToken}`)
    expect(orgsRes.status).toBe(200)
    const orgAListing = orgsRes.body.data.find((o: any) => o.id === String(orgA._id))
    expect(orgAListing?.isDefault).toBe(true)

    // Login 2nd time: returns activeOrgId === orgA._id
    const login2 = await request(app).post("/api/v1/auth/login").send({
      email: "scenario7@flintflow.test",
      password: "Password123!"
    })
    expect(login2.status).toBe(200)
    expect(login2.body.data.activeOrgId).toBe(String(orgA._id))
    expect(verifyAccessToken(login2.body.data.accessToken).orgId).toBe(String(orgA._id))

    // Lead of Org A removes user from Org A
    const leadLogin = await request(app).post("/api/v1/auth/login").send({
      email: "lead7@flintflow.test",
      password: "Password123!"
    })
    const leadToken = leadLogin.body.data.accessToken

    const removeRes = await request(app)
      .delete(`/api/v1/orgs/${orgA._id}/members/${user._id}`)
      .set("Authorization", `Bearer ${leadToken}`)
    expect(removeRes.status).toBe(200)

    // Check preferredOrganizationId in DB is cleared
    const userDocAfterRemove = await User.findById(user._id).lean()
    expect(userDocAfterRemove?.preferredOrganizationId ?? null).toBeNull()

    // Login 3rd time: remaining 2 orgs (orgB, orgC), activeOrgId is null (fallback)
    const login3 = await request(app).post("/api/v1/auth/login").send({
      email: "scenario7@flintflow.test",
      password: "Password123!"
    })
    expect(login3.status).toBe(200)
    expect(login3.body.data.activeOrgId).toBeNull()
    expect(login3.body.data.organizations).toHaveLength(2)

    // Lead removes user from Org B
    await request(app)
      .delete(`/api/v1/orgs/${orgB._id}/members/${user._id}`)
      .set("Authorization", `Bearer ${leadToken}`)

    // Login 4th time: only 1 org left (Org C) -> auto-selects activeOrgId: Org C
    const login4 = await request(app).post("/api/v1/auth/login").send({
      email: "scenario7@flintflow.test",
      password: "Password123!"
    })
    expect(login4.status).toBe(200)
    expect(login4.body.data.activeOrgId).toBe(String(orgC._id))

    // Test PATCH /users/me setting and clearing preferredOrganizationId
    const patchSetRes = await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${login4.body.data.accessToken}`)
      .send({ preferredOrganizationId: String(orgC._id) })
    expect(patchSetRes.status).toBe(200)
    expect(patchSetRes.body.data.preferredOrganizationId).toBe(String(orgC._id))

    const patchClearRes = await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${login4.body.data.accessToken}`)
      .send({ preferredOrganizationId: null })
    expect(patchClearRes.status).toBe(200)
    expect(patchClearRes.body.data.preferredOrganizationId).toBeNull()
  })
})
