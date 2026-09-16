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
import { seedFixture, type SeededFixture } from "../setup.js"
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

const CLIENT_ID = "flintflow-test-client"
let orderSeq = 0

const remoteOrder = (orderId: string, status: PaymentServiceOrder["status"]): PaymentServiceOrder => ({
  order_id: orderId,
  client_id: CLIENT_ID,
  amount: 4000,
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
