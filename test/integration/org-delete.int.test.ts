/**
 * Xoá tổ chức (yêu cầu 2026-09-26) — chỉ khi Lead là thành viên duy nhất; xoá cả dự án, thư mục, ví, gói;
 * giữ sổ giao dịch credit làm hồ sơ tài chính.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Organization } from "../../src/modules/organization/organization.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { Invitation } from "../../src/modules/organization/invitation.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Folder } from "../../src/modules/folder/folder.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { Subscription } from "../../src/modules/credits/subscription.model.js"
import { CreditTransaction } from "../../src/modules/credits/credit-transaction.model.js"
import { PaymentIntent } from "../../src/modules/billing/payment-intent.model.js"
import { Session } from "../../src/shared/auth/session.model.js"
import { authAs } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

let lead: { id: string; email: string; token: string }
let orgId: string

beforeEach(async () => {
  const user = await User.create({ email: "lead@flintflow.test", password: "test-password-123", emailVerified: true })
  const token = await authAs({ _id: user._id, email: user.email })
  const res = await request(app).post("/api/v1/orgs").set(bearer(token)).send({ name: "Org Một Mình" })
  orgId = res.body.data.id
  lead = { id: String(user._id), email: user.email, token: await authAs({ _id: user._id, email: user.email, orgId }) }
})

const del = (confirmName = "Org Một Mình", token = lead.token) =>
  request(app).delete("/api/v1/orgs/" + orgId).set(bearer(token)).send({ confirmName })

describe("xoá tổ chức", () => {
  it("Lead duy nhất xoá được — dự án, thư mục, ví, gói, thành viên đều biến mất", async () => {
    await request(app).post("/api/v1/projects").set(bearer(lead.token)).send({ name: "Dự án 1" })
    await request(app).post("/api/v1/projects").set(bearer(lead.token)).send({ name: "Dự án 2" })
    await Folder.create({ organizationId: orgId, userId: lead.id, name: "Thư mục" })
    expect(await Project.countDocuments({ organizationId: orgId })).toBe(2)

    const res = await del()
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ deleted: true, projectsDeleted: 2 })

    expect(await Organization.countDocuments({ _id: orgId })).toBe(0)
    expect(await Membership.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await Project.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await Folder.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await CreditWallet.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await Subscription.countDocuments({ organizationId: orgId })).toBe(0)
  })

  it("giữ lại sổ giao dịch credit làm hồ sơ tài chính", async () => {
    await CreditTransaction.create({
      userId: lead.id,
      organizationId: orgId,
      actionType: "purchase",
      amount: 100,
      type: "purchase",
      balanceAfter: 200
    })

    expect((await del()).status).toBe(200)
    expect(await CreditTransaction.countDocuments({ organizationId: orgId })).toBe(1)
  })

  it("gõ sai tên thì không xoá gì", async () => {
    const res = await del("Tên khác")
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("ORG_NAME_MISMATCH")
    expect(await Organization.countDocuments({ _id: orgId })).toBe(1)
  })

  it("còn thành viên khác thì từ chối", async () => {
    const other = await User.create({ email: "other@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: orgId, userId: other._id, role: "viewer" })

    const res = await del()
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("ORG_HAS_OTHER_MEMBERS")
    expect(await Organization.countDocuments({ _id: orgId })).toBe(1)
  })

  it("thành viên không phải Lead không gọi được", async () => {
    const other = await User.create({ email: "an@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: orgId, userId: other._id, role: "analyst" })
    const token = await authAs({ _id: other._id, email: other.email, orgId })

    const res = await del("Org Một Mình", token)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("đang có lượt gọi AI giữ credit thì từ chối", async () => {
    await CreditWallet.updateOne({ organizationId: orgId }, { reserved: 5 })
    const res = await del()
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("ORG_BUSY")
  })

  it("đang có thanh toán chờ thì từ chối — webhook về sau sẽ không có ví để cộng", async () => {
    await PaymentIntent.create({
      userId: lead.id,
      organizationId: orgId,
      packageId: "pack_100",
      credits: 100,
      amount: 4000,
      currency: "VND",
      provider: "payment_service",
      status: "pending"
    })
    const res = await del()
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("ORG_PAYMENT_PENDING")
  })

  it("mã mời của org bị huỷ, phiên đang mở org được gỡ org đang mở", async () => {
    await request(app).post("/api/v1/orgs/" + orgId + "/invitations").set(bearer(lead.token)).send({ role: "viewer" })
    await Session.create({
      userId: lead.id,
      tokenHash: "hash-" + Date.now(),
      expiresAt: new Date(Date.now() + 60_000),
      activeOrgId: orgId
    })

    expect((await del()).status).toBe(200)
    expect(await Invitation.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await Session.countDocuments({ activeOrgId: orgId })).toBe(0)
  })

  it("xoá org cuối cùng thì tài khoản quay về trạng thái cần onboarding", async () => {
    expect((await del()).status).toBe(200)
    const orgs = await request(app).get("/api/v1/orgs").set(bearer(lead.token))
    expect(orgs.body.data).toEqual([])
  })
})
