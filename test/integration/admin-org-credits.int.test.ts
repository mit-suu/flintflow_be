/**
 * task-26 Pha 4b — UC-68 Administrator điều chỉnh credit của TỔ CHỨC (không phải của người),
 * và UC-65 xem một user thuộc những org nào.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { CreditTransaction } from "../../src/modules/credits/credit-transaction.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { authAs } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

let admin: string
let lead: { id: string; email: string; token: string }
let orgId: string

beforeEach(async () => {
  const adminUser = await User.create({
    email: "admin@flintflow.test",
    password: "test-password-123",
    role: "admin",
    emailVerified: true
  })
  admin = await authAs({ _id: adminUser._id, email: adminUser.email, role: "admin" })

  const leadUser = await User.create({
    email: "lead@flintflow.test",
    password: "test-password-123",
    emailVerified: true
  })
  lead = {
    id: String(leadUser._id),
    email: leadUser.email,
    token: await authAs({ _id: leadUser._id, email: leadUser.email })
  }

  const res = await request(app).post("/api/v1/orgs").set(bearer(lead.token)).send({ name: "Org A" })
  orgId = res.body.data.id
})

const adjust = (amount: number, reason = "Bù cho sự cố hệ thống") =>
  request(app).patch("/api/v1/admin/orgs/" + orgId + "/credits").set(bearer(admin)).send({ amount, reason })

describe("UC-68 — điều chỉnh credit tổ chức", () => {
  it("cộng credit vào ví org và ghi lý do vào ledger", async () => {
    const before = await CreditWallet.findOne({ organizationId: orgId }).lean()

    const res = await adjust(50, "Bù cho sự cố ngày 20/09")
    expect(res.status).toBe(200)
    expect(res.body.data.balance).toBe((before?.balance ?? 0) + 50)

    const entry = await CreditTransaction.findOne({ organizationId: orgId, type: "admin_adjust" }).lean()
    expect(entry?.reason).toBe("Bù cho sự cố ngày 20/09")
    expect(entry?.amount).toBe(50)
  })

  it("trừ credit được, nhưng không cho số dư xuống âm", async () => {
    const wallet = await CreditWallet.findOne({ organizationId: orgId }).lean()
    const balance = wallet?.balance ?? 0

    expect((await adjust(-10)).status).toBe(200)

    const tooMuch = await adjust(-(balance * 10))
    expect(tooMuch.status).toBe(409)
    expect(tooMuch.body.error.code).toBe("INSUFFICIENT_CREDIT")

    const after = await CreditWallet.findOne({ organizationId: orgId }).lean()
    expect(after?.balance).toBe(balance - 10)
  })

  it("không đụng phần credit đang được giữ cho lượt gọi AI đang chạy", async () => {
    await CreditWallet.updateOne({ organizationId: orgId }, { balance: 100, reserved: 80 })

    // Khả dụng chỉ còn 20 ⇒ trừ 50 phải bị từ chối, không được ăn vào phần đang giữ
    const res = await adjust(-50)
    expect(res.status).toBe(409)

    const wallet = await CreditWallet.findOne({ organizationId: orgId }).lean()
    expect(wallet?.balance).toBe(100)
    expect(wallet?.reserved).toBe(80)
  })

  it("Lead của org được thông báo kèm lý do", async () => {
    await adjust(25, "Khuyến mãi tháng 9")

    const note = await Notification.findOne({ userId: lead.id, type: "credits_adjusted" }).lean()
    expect(note).not.toBeNull()
    expect(note?.body).toContain("Khuyến mãi tháng 9")
    expect(String(note?.organizationId)).toBe(orgId)
  })

  it("chặn dữ liệu vào không hợp lệ và org không tồn tại", async () => {
    expect((await adjust(0)).status).toBe(400)

    const noReason = await request(app)
      .patch("/api/v1/admin/orgs/" + orgId + "/credits")
      .set(bearer(admin))
      .send({ amount: 10 })
    expect(noReason.status).toBe(400)

    const missing = await request(app)
      .patch("/api/v1/admin/orgs/64b000000000000000000001/credits")
      .set(bearer(admin))
      .send({ amount: 10, reason: "thử" })
    expect(missing.status).toBe(404)
  })

  it("người dùng thường không gọi được", async () => {
    const res = await request(app)
      .patch("/api/v1/admin/orgs/" + orgId + "/credits")
      .set(bearer(lead.token))
      .send({ amount: 10, reason: "tự cộng cho mình" })
    expect(res.status).toBe(403)
  })
})

describe("UC-65 — xem user thuộc org nào", () => {
  it("chi tiết user liệt kê org, vai trò và ví của từng org", async () => {
    const res = await request(app).get("/api/v1/admin/users/" + lead.id).set(bearer(admin))

    expect(res.status).toBe(200)
    expect(res.body.data.organizationsCount).toBe(1)
    expect(res.body.data.organizations).toHaveLength(1)
    expect(res.body.data.organizations[0]).toMatchObject({ id: orgId, name: "Org A", role: "lead" })
    expect(res.body.data.organizations[0].wallet.balance).toBeGreaterThan(0)
  })
})
