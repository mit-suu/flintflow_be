/**
 * billing (T22) — `/api/v1/billing/*` qua HTTP trên Mongo replica set thật. Chỉ `payment-service.client`
 * (HTTP ra payment_service bên ngoài) bị mock; intent, ví, ledger, notification là code thật.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../src/modules/billing/payment-service.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/modules/billing/payment-service.client.js")>()
  return {
    ...actual,
    isPaymentServiceConfigured: vi.fn(() => true),
    createPaymentOrder: vi.fn(),
    getPaymentOrder: vi.fn()
  }
})

import app from "../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"
import {
  createPaymentOrder,
  getPaymentOrder,
  isPaymentServiceConfigured,
  type PaymentServiceOrder
} from "../../src/modules/billing/payment-service.client.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { CreditTransaction } from "../../src/modules/credits/credit-transaction.model.js"
import { PaymentIntent } from "../../src/modules/billing/payment-intent.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { executeAiAction } from "../../src/shared/ai/ai-action.service.js"
import { ActionType } from "../../src/shared/ai/ai-action.types.js"
import { Subscription } from "../../src/modules/credits/subscription.model.js"

const CLIENT_ID = "flintflow-test-client"
let orderSeq = 0

const remoteOrder = (orderId: string, status: PaymentServiceOrder["status"]): PaymentServiceOrder => ({
  order_id: orderId,
  client_id: CLIENT_ID,
  // FLF-207: gói 100 credit là 40.000₫ (đồng giá ~400₫/credit); callback phải khớp số tiền của gói
  amount: 40_000,
  description: "FlintFlow pack_100",
  reference_code: `REF-${orderId}`,
  callback_url: "http://localhost:5000/api/v1/billing/payment-callback",
  status,
  sepay_transaction_id: status === "paid" ? 1 : null,
  created_at: new Date().toISOString(),
  paid_at: status === "paid" ? new Date().toISOString() : null
})

const as = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })

/** Tạo checkout pack_100 và trả `order_id` phía payment_service. */
const checkout = async (seeded: SeededFixture): Promise<{ intentId: string; orderId: string }> => {
  orderSeq += 1
  const orderId = `order-${orderSeq}`
  vi.mocked(createPaymentOrder).mockResolvedValueOnce({
    order_id: orderId,
    reference_code: `REF-${orderId}`,
    payment_description: `FF ${orderId}`,
    qr_code_url: "https://qr.example/test.png"
  } as Awaited<ReturnType<typeof createPaymentOrder>>)
  const res = await request(app).post("/api/v1/billing/checkout").set(as(seeded)).send({ packageId: "pack_100" })
  expect(res.status, JSON.stringify(res.body.error)).toBe(201)
  return { intentId: String(res.body.data.id ?? res.body.data.intentId ?? res.body.data._id), orderId }
}

const callback = (orderId: string, clientId = CLIENT_ID) =>
  request(app).post("/api/v1/billing/payment-callback").send({ order_id: orderId, status: "paid", client_id: clientId })

beforeEach(() => {
  vi.mocked(isPaymentServiceConfigured).mockReturnValue(true)
  vi.mocked(createPaymentOrder).mockReset()
  vi.mocked(getPaymentOrder).mockReset()
})

describe("số dư, gói, lịch sử", () => {
  it("401 khi thiếu token; balance/packages/transactions trả đúng ví đã seed", async () => {
    expect((await request(app).get("/api/v1/billing/balance")).status).toBe(401)

    const seeded = await seedFixture("minimal", { balance: 250 })
    const balance = await request(app).get("/api/v1/billing/balance").set(as(seeded))
    expect(balance.status).toBe(200)
    expect(balance.body.data).toMatchObject({ balance: 250, reserved: 0, available: 250, plan: "free" })

    const packages = await request(app).get("/api/v1/billing/packages").set(as(seeded))
    expect(packages.body.data.packages.map((p: { id: string }) => p.id)).toContain("pack_100")

    const transactions = await request(app).get("/api/v1/billing/transactions?page=1&limit=5").set(as(seeded))
    expect(transactions.status).toBe(200)
    expect(transactions.body.meta).toMatchObject({ page: 1, limit: 5 })
  })

  it("user chưa có ví ⇒ ví tự tạo với credit miễn phí ban đầu", async () => {
    const seeded = await seedFixture("minimal", { balance: null })
    const balance = await request(app).get("/api/v1/billing/balance").set(as(seeded))
    expect(balance.status).toBe(200)
    expect(balance.body.data.balance).toBeGreaterThan(0)
    expect(await CreditWallet.countDocuments({ userId: seeded.userId })).toBe(1)
  })
})

describe("lịch sử credit (UC-59, UC-60)", () => {
  const history = (token: string, query = "") =>
    request(app).get(`/api/v1/billing/transactions${query}`).set({ Authorization: `Bearer ${token}` })

  it("Lead thấy thanh toán đang chờ / lỗi kèm người nạp; Analyst không thấy dòng thanh toán", async () => {
    const seeded = await seedFixture("minimal", { balance: 100 })
    const { intentId } = await checkout(seeded)
    const failed = await checkout(seeded)
    await PaymentIntent.updateOne({ _id: failed.intentId }, { $set: { status: "failed" } })

    const lead = await history(seeded.token)
    expect(lead.status).toBe(200)
    const payments = lead.body.data.filter((r: { type: string }) => r.type === "payment")
    expect(payments.map((r: { paymentStatus: string }) => r.paymentStatus).sort()).toEqual(["failed", "pending"])
    expect(payments.find((r: { intentId: string }) => r.intentId === intentId)).toMatchObject({
      amount: 100,
      packageId: "pack_100",
      member: { id: seeded.userId }
    })

    const analystUser = await User.create({ email: "analyst@flintflow.test", password: "test-password-123", name: "An Analyst", emailVerified: true })
    await Membership.create({ organizationId: seeded.orgId, userId: analystUser._id, role: "analyst" })
    const analystToken = await authAs({ _id: analystUser._id, email: analystUser.email, orgId: seeded.orgId })
    const analyst = await history(analystToken)
    expect(analyst.status).toBe(200)
    expect(analyst.body.data.some((r: { type: string }) => r.type === "payment")).toBe(false)
  })

  it("lượt gọi AI trong pipeline ghi step + token; lịch sử trả kèm thành viên và dự án; lọc sai mã ⇒ 400", async () => {
    const seeded = await seedFixture("minimal", { balance: 100 })
    // Provider mock: CI không có API key
    await executeAiAction(ActionType.CHAT, { promptVariables: { step_id: "S-1.1" } }, seeded.projectId, seeded.userId, { provider: "mock" })

    const res = await history(seeded.token, `?kind=usage&projectId=${seeded.projectId}`)
    expect(res.status).toBe(200)
    const deduct = res.body.data.find((r: { type: string }) => r.type === "deduct")
    expect(deduct).toMatchObject({ stepId: "S-1.1", member: { id: seeded.userId }, project: { id: seeded.projectId } })
    expect(deduct.tokensIn).toBeGreaterThan(0)
    expect(deduct.project.name).not.toBe("")

    expect((await history(seeded.token, "?memberId=abc")).status).toBe(400)
  })
})

describe("không hạ gói (FLF-347)", () => {
  it("Pro còn hạn ⇒ POST /upgrade free trả 409, gói và ví giữ nguyên", async () => {
    const seeded = await seedFixture("minimal", { balance: 500 })
    await Subscription.create({
      userId: seeded.userId,
      organizationId: seeded.orgId,
      plan: "pro",
      status: "active",
      monthlyCreditsAllotment: 1000,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000)
    })

    const res = await request(app).post("/api/v1/billing/upgrade").set(as(seeded)).send({ plan: "free" })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("PLAN_DOWNGRADE_NOT_SUPPORTED")
    expect((await Subscription.findOne({ organizationId: seeded.orgId }).lean())?.plan).toBe("pro")
    expect((await CreditWallet.findOne({ organizationId: seeded.orgId }).lean())?.balance).toBe(500)
  })
})

describe("checkout và callback thanh toán", () => {
  it("cổng chưa cấu hình ⇒ 503; gói lạ ⇒ 404", async () => {
    const seeded = await seedFixture("minimal")
    vi.mocked(isPaymentServiceConfigured).mockReturnValue(false)
    const unconfigured = await request(app).post("/api/v1/billing/checkout").set(as(seeded)).send({ packageId: "pack_100" })
    expect(unconfigured.status).toBe(503)
    expect(unconfigured.body.error.code).toBe("PAYMENT_SERVICE_NOT_CONFIGURED")

    const unknown = await request(app).post("/api/v1/billing/checkout").set(as(seeded)).send({ packageId: "pack_nope" })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe("PACKAGE_NOT_FOUND")
  })

  it("paid ⇒ cộng credit đúng một lần, ledger purchase, notification; callback lặp lại không cộng thêm", async () => {
    const seeded = await seedFixture("minimal", { balance: 50 })
    const { orderId } = await checkout(seeded)
    expect(await PaymentIntent.countDocuments({ userId: seeded.userId, status: "pending" })).toBe(1)

    vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder(orderId, "paid"))
    const first = await callback(orderId)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ success: true, status: "succeeded", alreadyProcessed: false, creditsAdded: 100 })

    const again = await callback(orderId)
    expect(again.body).toMatchObject({ success: true, alreadyProcessed: true, creditsAdded: 0 })

    expect((await CreditWallet.findOne({ userId: seeded.userId }).lean())?.balance).toBe(150)
    expect(await CreditTransaction.countDocuments({ userId: seeded.userId, type: "purchase" })).toBe(1)
    await vi.waitFor(async () => {
      expect(await Notification.countDocuments({ userId: seeded.userId, type: "payment_success" })).toBe(1)
    })
  })

  it("hai callback paid đến đồng thời ⇒ credit chỉ cộng một lần", async () => {
    const seeded = await seedFixture("minimal", { balance: 0 })
    const { orderId } = await checkout(seeded)
    vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder(orderId, "paid"))

    const results = await Promise.all([callback(orderId), callback(orderId), callback(orderId)])
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(results.reduce((sum, r) => sum + (r.body.creditsAdded as number), 0)).toBe(100)
    expect((await CreditWallet.findOne({ userId: seeded.userId }).lean())?.balance).toBe(100)
    expect(await CreditTransaction.countDocuments({ userId: seeded.userId, type: "purchase" })).toBe(1)
  })

  it("remote báo failed ⇒ intent failed, không cộng credit; client_id sai ⇒ 403; order lạ ⇒ 404", async () => {
    const seeded = await seedFixture("minimal", { balance: 10 })
    const { orderId } = await checkout(seeded)

    const wrongClient = await callback(orderId, "someone-else")
    expect(wrongClient.status).toBe(403)

    const unknown = await callback("order-does-not-exist")
    expect(unknown.status).toBe(404)

    vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder(orderId, "failed"))
    const failed = await callback(orderId)
    expect(failed.status).toBe(200)
    expect(failed.body.creditsAdded).toBe(0)
    expect(await PaymentIntent.countDocuments({ userId: seeded.userId, status: "failed" })).toBe(1)
    expect((await CreditWallet.findOne({ userId: seeded.userId }).lean())?.balance).toBe(10)
  })

  it("GET /checkout/:id chỉ chủ intent xem được", async () => {
    const owner = await seedFixture("minimal")
    const other = await seedFixture("minimal")
    const { intentId } = await checkout(owner)

    const mine = await request(app).get(`/api/v1/billing/checkout/${intentId}`).set(as(owner))
    expect(mine.status, JSON.stringify(mine.body)).toBe(200)
    const foreign = await request(app).get(`/api/v1/billing/checkout/${intentId}`).set(as(other))
    expect(foreign.status).toBe(404)
  })
})

describe("FLF-417 Task 4: planLimits, succeeded payment metadata & RBAC (UC-56, UC-59, UC-60)", () => {
  it("Lead thấy giao dịch nạp succeeded có đủ intentId, packageId, price VND, currency, referenceCode; getBalance trả planLimits; /packages trả đủ trường plan (UC-56, UC-59)", async () => {
    const seeded = await seedFixture("minimal", { balance: 100 })
    const { intentId, orderId } = await checkout(seeded)
    vi.mocked(getPaymentOrder).mockResolvedValueOnce(remoteOrder(orderId, "paid"))
    expect((await callback(orderId)).status).toBe(200)

    const bal = await request(app).get("/api/v1/billing/balance").set(as(seeded))
    expect(bal.status).toBe(200)
    expect(bal.body.data.planLimits).toEqual({ maxMembers: 3, maxProjects: 3, monthlyCredits: 300 })

    const pkgRes = await request(app).get("/api/v1/billing/packages").set(as(seeded))
    expect(pkgRes.status).toBe(200)
    for (const plan of pkgRes.body.data.plans as Array<Record<string, unknown>>) {
      expect(plan).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          label: expect.any(String),
          monthlyCredits: expect.any(Number),
          priceVnd: expect.any(Number),
          maxMembers: expect.any(Number),
          maxProjects: expect.any(Number),
          maxReferenceTokens: expect.any(Number)
        })
      )
    }

    const txRes = await request(app).get("/api/v1/billing/transactions?kind=payment").set(as(seeded))
    expect(txRes.status).toBe(200)
    const succeeded = txRes.body.data.find((r: { type: string }) => r.type === "purchase")
    expect(succeeded).toMatchObject({
      type: "purchase",
      paymentStatus: "succeeded",
      intentId,
      packageId: "pack_100",
      price: 40_000,
      currency: "VND",
      referenceCode: `REF-${orderId}`,
      amount: 100
    })

    // Dòng purchase cũ chưa có metadata trên CreditTransaction vẫn backfill từ PaymentIntent succeeded
    const legacyIntent = await PaymentIntent.create({
      userId: seeded.userId,
      organizationId: seeded.orgId,
      packageId: "pack_500",
      credits: 500,
      amount: 199_000,
      currency: "VND",
      status: "succeeded",
      referenceCode: "REF-LEGACY-500",
      processedAt: new Date(Date.now() - 60_000)
    })
    await CreditTransaction.create({
      userId: seeded.userId,
      organizationId: seeded.orgId,
      actionType: "purchase",
      type: "purchase",
      amount: 500,
      balanceAfter: 700,
      createdAt: new Date(Date.now() - 60_000)
    })

    const legacyRes = await request(app).get("/api/v1/billing/transactions?kind=payment").set(as(seeded))
    expect(legacyRes.status).toBe(200)
    const legacyRow = legacyRes.body.data.find((r: { amount: number }) => r.amount === 500)
    expect(legacyRow).toMatchObject({
      type: "purchase",
      paymentStatus: "succeeded",
      intentId: String(legacyIntent._id),
      packageId: "pack_500",
      price: 199_000,
      currency: "VND",
      referenceCode: "REF-LEGACY-500"
    })
  })

  it("RBAC: Analyst chỉ thấy USAGE_TYPES ở balance.ledger và transactions (kể cả ?kind=payment); Viewer bị 403 ở /billing/packages và ẩn ví ở /users/me", async () => {
    const seeded = await seedFixture("minimal", { balance: 250 })
    await CreditTransaction.create({
      userId: seeded.userId,
      organizationId: seeded.orgId,
      type: "admin_adjust",
      actionType: "admin_adjust",
      amount: 50,
      balanceAfter: 300
    })
    await CreditTransaction.create({
      userId: seeded.userId,
      organizationId: seeded.orgId,
      type: "monthly_reset",
      actionType: "monthly_reset",
      amount: 300,
      balanceAfter: 600
    })
    const { orderId } = await checkout(seeded)
    vi.mocked(getPaymentOrder).mockResolvedValueOnce(remoteOrder(orderId, "paid"))
    expect((await callback(orderId)).status).toBe(200)
    // Tạo thêm 1 giao dịch pending để đảm bảo Analyst cũng không thấy dòng PaymentIntent
    await checkout(seeded)

    const analyst = await User.create({ email: "ba-rbac@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: seeded.orgId, userId: analyst._id, role: "analyst" })
    const analystToken = await authAs({ _id: analyst._id, email: analyst.email, orgId: seeded.orgId })

    expect((await request(app).get("/api/v1/billing/packages").set({ Authorization: `Bearer ${analystToken}` })).status).toBe(200)

    const analystBal = await request(app).get("/api/v1/billing/balance").set({ Authorization: `Bearer ${analystToken}` })
    expect(analystBal.status).toBe(200)
    expect(analystBal.body.data.planLimits).toEqual({ maxMembers: 3, maxProjects: 3, monthlyCredits: 300 })
    expect(analystBal.body.data.ledger).toEqual([])

    const analystAll = await request(app).get("/api/v1/billing/transactions").set({ Authorization: `Bearer ${analystToken}` })
    expect(analystAll.status).toBe(200)
    expect(analystAll.body.data).toEqual([])

    const analystPay = await request(app).get("/api/v1/billing/transactions?kind=payment").set({ Authorization: `Bearer ${analystToken}` })
    expect(analystPay.status).toBe(200)
    expect(analystPay.body.data).toEqual([])
    expect(analystPay.body.meta).toMatchObject({ total: 0, totalPages: 0 })

    // Khi có dòng USAGE_TYPES (reserve/deduct), Analyst chỉ nhận đúng các dòng USAGE_TYPES
    await executeAiAction(ActionType.CHAT, { promptVariables: { step_id: "S-1.1" } }, seeded.projectId, analyst._id.toString(), { provider: "mock" })
    const analystWithUsageBal = await request(app).get("/api/v1/billing/balance").set({ Authorization: `Bearer ${analystToken}` })
    expect(analystWithUsageBal.body.data.ledger.length).toBeGreaterThan(0)
    expect(
      analystWithUsageBal.body.data.ledger.every((r: { type: string }) => ["reserve", "deduct", "release", "refund"].includes(r.type))
    ).toBe(true)

    const analystWithUsageTx = await request(app).get("/api/v1/billing/transactions").set({ Authorization: `Bearer ${analystToken}` })
    expect(analystWithUsageTx.body.data.length).toBeGreaterThan(0)
    expect(
      analystWithUsageTx.body.data.every((r: { type: string }) => ["reserve", "deduct", "release", "refund"].includes(r.type))
    ).toBe(true)
    const analystStillNoPay = await request(app).get("/api/v1/billing/transactions?kind=payment").set({ Authorization: `Bearer ${analystToken}` })
    expect(analystStillNoPay.body.data).toEqual([])

    // Analyst vẫn xem được số dư org ở /users/me
    const analystMe = await request(app).get("/api/v1/users/me").set({ Authorization: `Bearer ${analystToken}` })
    expect(analystMe.status).toBe(200)
    expect(analystMe.body.data.creditOrganization).toEqual({ id: seeded.orgId, name: "Fixture Org" })
    expect(analystMe.body.data.balance).toBeGreaterThan(0)

    const viewer = await User.create({ email: "viewer-rbac@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: seeded.orgId, userId: viewer._id, role: "viewer" })
    const viewerToken = await authAs({ _id: viewer._id, email: viewer.email, orgId: seeded.orgId })

    expect((await request(app).get("/api/v1/billing/packages").set({ Authorization: `Bearer ${viewerToken}` })).status).toBe(403)
    expect((await request(app).get("/api/v1/billing/balance").set({ Authorization: `Bearer ${viewerToken}` })).status).toBe(403)
    expect((await request(app).get("/api/v1/billing/transactions").set({ Authorization: `Bearer ${viewerToken}` })).status).toBe(403)

    const viewerMe = await request(app).get("/api/v1/users/me").set({ Authorization: `Bearer ${viewerToken}` })
    expect(viewerMe.status).toBe(200)
    expect(viewerMe.body.data).toMatchObject({ balance: 0, creditOrganization: null })
  })
})
