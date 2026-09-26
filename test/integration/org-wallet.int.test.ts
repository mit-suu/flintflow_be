/**
 * task-26 — hai việc:
 *  1. Nợ Pha 2: tạo org thì MỞ VÍ luôn (BPMN Flow 8.2 "open the wallet").
 *  2. Lỗ hổng Pha 1: BPMN Flow 10.4 nay áp cho mọi route đã đăng nhập, không riêng /projects.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { Subscription } from "../../src/modules/credits/subscription.model.js"
import { planConfig } from "../../src/modules/billing/plan.config.js"
import { authAs } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

let lead: { id: string; email: string; token: string }

const makeUser = async (email: string) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  return { id: String(user._id), email, token: await authAs({ _id: user._id, email }) }
}

const joinOrg = async (orgId: string, email: string, role: OrgRole) => {
  const user = await makeUser(email)
  await Membership.create({ organizationId: orgId, userId: user.id, role })
  return { ...user, token: await authAs({ _id: user.id, email, orgId }) }
}

beforeEach(async () => {
  lead = await makeUser("lead@flintflow.test")
})

const createOrg = async (name = "Org A") => {
  const res = await request(app).post("/api/v1/orgs").set(bearer(lead.token)).send({ name })
  expect(res.status).toBe(201)
  return res.body.data.id as string
}

describe("nợ Pha 2 — tạo org là mở ví (Flow 8.2)", () => {
  it("org mới có ngay ví credit free và gói free", async () => {
    const orgId = await createOrg()

    const wallet = await CreditWallet.findOne({ organizationId: orgId }).lean()
    expect(wallet).not.toBeNull()
    expect(wallet?.balance).toBe(planConfig.free.initialCredits)
    expect(wallet?.reserved).toBe(0)

    const subscription = await Subscription.findOne({ organizationId: orgId }).lean()
    expect(subscription?.plan).toBe("free")
    expect(subscription?.status).toBe("active")
  })

  it("một người tạo hai org thì mỗi org một ví riêng", async () => {
    const first = await createOrg("Org A")
    const second = await createOrg("Org B")

    expect(first).not.toBe(second)
    expect(await CreditWallet.countDocuments({ userId: lead.id })).toBe(2)
    const balances = await CreditWallet.find({ userId: lead.id }).select("organizationId").lean()
    expect(new Set(balances.map((w) => String(w.organizationId))).size).toBe(2)
  })

  it("số dư API đọc đúng ví của org đang mở, không phải ví người dùng", async () => {
    const orgId = await createOrg()
    await CreditWallet.updateOne({ organizationId: orgId }, { balance: 777 })
    const token = await authAs({ _id: lead.id, email: lead.email, orgId })

    const res = await request(app).get("/api/v1/billing/balance").set(bearer(token))
    expect(res.status).toBe(200)
    expect(res.body.data.balance).toBe(777)
    expect(res.body.data.plan).toBe("free")
  })

  it("chỉ Lead mua được credit; Analyst bị chặn và phải báo Lead (UC-60)", async () => {
    const orgId = await createOrg()
    const analyst = await joinOrg(orgId, "analyst@flintflow.test", "analyst")

    const denied = await request(app)
      .post("/api/v1/billing/checkout")
      .set(bearer(analyst.token))
      .send({ packageId: "pack_100" })
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe("ORG_ROLE_FORBIDDEN")

    // Analyst vẫn xem được số dư để biết mà báo Lead (UC-58)
    const balance = await request(app).get("/api/v1/billing/balance").set(bearer(analyst.token))
    expect(balance.status).toBe(200)
  })
})

describe("lỗ hổng Pha 1 — Flow 10.4 nay phủ mọi route đã đăng nhập", () => {
  it("tài khoản bị khoá mất quyền ở thông báo, hồ sơ và billing, không chỉ /projects", async () => {
    const orgId = await createOrg()
    const token = await authAs({ _id: lead.id, email: lead.email, orgId })

    expect((await request(app).get("/api/v1/notifications").set(bearer(token))).status).toBe(200)
    expect((await request(app).get("/api/v1/users/me").set(bearer(token))).status).toBe(200)

    await User.updateOne({ _id: lead.id }, { isActive: false })

    for (const path of ["/api/v1/notifications", "/api/v1/users/me", "/api/v1/billing/balance"]) {
      const res = await request(app).get(path).set(bearer(token))
      expect(res.status, path).toBe(403)
      expect(res.body.error.code, path).toBe("ACCOUNT_SUSPENDED")
    }
  })

  it("webhook thanh toán KHÔNG bị chặn — nó không mang token", async () => {
    // Không có Authorization: guard chặn thì đây sẽ là 401, làm hỏng luồng nạp tiền thật.
    const res = await request(app).post("/api/v1/billing/payment-callback").send({})
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})

describe("gọi AI trừ vào ví của org sở hữu project (business-flow.md §2)", () => {
  it("reserve + deduct đánh vào ví org, ví cá nhân của người gọi không suy chuyển", async () => {
    const { reserveCredit, deductCredit } = await import("../../src/shared/ai/credit-reservation.service.js")
    const { Project } = await import("../../src/modules/project/project.model.js")

    const orgId = await createOrg()
    const member = await joinOrg(orgId, "author@flintflow.test", "analyst")
    // Ví cá nhân cũ của chính người gọi — không được đụng tới
    await CreditWallet.create({ userId: member.id, organizationId: null, balance: 500, reserved: 0 })

    const project = await Project.create({
      userId: member.id,
      organizationId: orgId,
      name: "Dự án của tổ chức",
      status: "active",
      mode: "fpt"
    })

    const before = await CreditWallet.findOne({ organizationId: orgId }).lean()
    const reservation = await reserveCredit(member.id, "chat", String(project._id))
    expect(reservation.organizationId).toBe(orgId)

    const held = await CreditWallet.findOne({ organizationId: orgId }).lean()
    expect(held?.reserved).toBe(reservation.cost)

    await deductCredit(reservation)

    const after = await CreditWallet.findOne({ organizationId: orgId }).lean()
    expect(after?.balance).toBe((before?.balance ?? 0) - reservation.cost)
    expect(after?.reserved).toBe(0)

    const personal = await CreditWallet.findOne({ userId: member.id, organizationId: null }).lean()
    expect(personal?.balance).toBe(500)
    expect(personal?.reserved).toBe(0)
  })

  it("lượt gọi không gắn project vẫn dùng ví cá nhân như trước", async () => {
    const { reserveCredit } = await import("../../src/shared/ai/credit-reservation.service.js")
    const solo = await makeUser("solo@flintflow.test")

    const reservation = await reserveCredit(solo.id, "chat")
    expect(reservation.organizationId).toBeNull()

    const personal = await CreditWallet.findOne({ userId: solo.id }).lean()
    expect(personal?.reserved).toBe(reservation.cost)
  })
})

describe("reservation hết hạn phải nhả về đúng ví org", () => {
  it("expireStaleReservations trả credit đang giữ về ví org, không để treo", async () => {
    const { reserveCredit, expireStaleReservations } = await import(
      "../../src/shared/ai/credit-reservation.service.js"
    )
    const { CreditTransaction } = await import("../../src/modules/credits/credit-transaction.model.js")
    const { Project } = await import("../../src/modules/project/project.model.js")

    const orgId = await createOrg()
    const project = await Project.create({
      userId: lead.id,
      organizationId: orgId,
      name: "Dự án",
      status: "active",
      mode: "fpt"
    })

    const reservation = await reserveCredit(lead.id, "chat", String(project._id))
    const held = await CreditWallet.findOne({ organizationId: orgId }).lean()
    expect(held?.reserved).toBe(reservation.cost)

    // Đẩy hạn giữ về quá khứ rồi chạy cron dọn
    await CreditTransaction.updateOne(
      { _id: reservation.reservationId },
      { expires_at: new Date(Date.now() - 1000) }
    )
    const result = await expireStaleReservations()
    expect(result.expiredCount).toBe(1)
    expect(result.releasedCredits).toBe(reservation.cost)

    const after = await CreditWallet.findOne({ organizationId: orgId }).lean()
    expect(after?.reserved).toBe(0)
    expect(after?.balance).toBe(held?.balance)
  })
})
