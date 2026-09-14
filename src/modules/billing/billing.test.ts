import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest"
import express from "express"
import mongoose from "mongoose"
import type { Server } from "http"
import type { AddressInfo } from "net"

vi.mock("../credits/credit-wallet.model.js", async () => {
  const { fakeDb } = await import("./__tests__/fake-mongo.js")
  return { CreditWallet: fakeDb.model("CreditWallet") }
})
vi.mock("../credits/credit-transaction.model.js", async () => {
  const { fakeDb } = await import("./__tests__/fake-mongo.js")
  return { CreditTransaction: fakeDb.model("CreditTransaction") }
})
vi.mock("../credits/subscription.model.js", async () => {
  const { fakeDb } = await import("./__tests__/fake-mongo.js")
  return { Subscription: fakeDb.model("Subscription") }
})
vi.mock("./payment-intent.model.js", async () => {
  const { fakeDb } = await import("./__tests__/fake-mongo.js")
  return { PaymentIntent: fakeDb.model("PaymentIntent") }
})
vi.mock("../admin/pricing-config.model.js", () => ({
  PricingConfig: { findOne: async () => null }
}))
vi.mock("../notification/notification.service.js", () => ({
  notify: vi.fn(async () => null),
  notifyAdmins: vi.fn(async () => 0)
}))
vi.mock("./payment-service.client.js", () => ({
  createPaymentOrder: vi.fn(),
  getPaymentOrder: vi.fn(),
  isPaymentServiceConfigured: vi.fn(() => true),
  buildCallbackUrl: vi.fn(() => "https://api.flintflow.test/api/v1/billing/payment-callback")
}))

import { fakeDb, TRANSACTION_UNSUPPORTED } from "./__tests__/fake-mongo.js"
import { notify } from "../notification/notification.service.js"
import { errorHandler } from "../../shared/middlewares/error-handler.js"
import { signAccessToken } from "../../shared/auth/jwt.util.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { env } from "../../config/env.js"
import billingRoutes from "./billing.route.js"
import * as billingService from "./billing.service.js"
import {
  createPaymentOrder,
  getPaymentOrder,
  isPaymentServiceConfigured,
  PaymentServiceOrder
} from "./payment-service.client.js"
import { planConfig } from "./plan.config.js"

const USER = "64b000000000000000000002"
const OTHER_USER = "64b000000000000000000003"
const CLIENT_ID = "client_flintflow_test"

const walletOf = (userId = USER) =>
  fakeDb.model("CreditWallet").docs.find((w) => String(w.userId) === userId)
const purchases = () => fakeDb.model("CreditTransaction").docs.filter((d) => d.type === "purchase")
const intentDoc = (intentId: string) =>
  fakeDb.model("PaymentIntent").docs.find((d) => String(d._id) === intentId)!

let orderSeq = 0
const mockCreateOrder = () =>
  vi.mocked(createPaymentOrder).mockImplementation(async () => {
    orderSeq += 1
    const ref = `REF${String(orderSeq).padStart(7, "0")}`
    return {
      order_id: `order-${orderSeq}`,
      status: "pending",
      reference_code: ref,
      payment_description: `PS${ref}`,
      qr_code_url: `https://vietqr.app/img?des=PS${ref}`
    }
  })

const remoteOrder = (orderId: string, overrides: Partial<PaymentServiceOrder> = {}): PaymentServiceOrder => ({
  order_id: orderId,
  client_id: CLIENT_ID,
  amount: 49_000,
  description: "x",
  reference_code: "REF",
  callback_url: "https://api.flintflow.test/api/v1/billing/payment-callback",
  status: "paid",
  sepay_transaction_id: 1,
  created_at: new Date().toISOString(),
  paid_at: new Date().toISOString(),
  ...overrides
})

const setup = () => {
  orderSeq = 0
  fakeDb.reset()
  vi.clearAllMocks()
  env.PAYMENT_CLIENT_ID = CLIENT_ID
  vi.mocked(isPaymentServiceConfigured).mockReturnValue(true)
  mockCreateOrder()
  vi.spyOn(mongoose, "startSession").mockRejectedValue(TRANSACTION_UNSUPPORTED)
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
}

describe("billing.service", () => {
  beforeEach(setup)

  describe("createCheckout", () => {
    it("tạo order trên payment_service (amount là number, có callback_url) và lưu QR", async () => {
      const checkout = await billingService.createCheckout(USER, "pack_100")

      expect(createPaymentOrder).toHaveBeenCalledWith({
        amount: 49_000,
        description: expect.stringContaining(checkout.intentId),
        callbackUrl: "https://api.flintflow.test/api/v1/billing/payment-callback"
      })
      expect(checkout).toMatchObject({
        status: "pending",
        credits: 100,
        amount: 49_000,
        qrCodeUrl: expect.stringContaining("vietqr"),
        paymentDescription: expect.stringMatching(/^PS/)
      })
      expect(intentDoc(checkout.intentId).paymentOrderId).toBe("order-1")
    })

    it("gói không tồn tại thì 404, không gọi payment_service", async () => {
      await expect(billingService.createCheckout(USER, "pack_nope")).rejects.toMatchObject({ statusCode: 404 })
      expect(createPaymentOrder).not.toHaveBeenCalled()
    })

    it("chưa cấu hình payment_service thì 503 và không tạo intent", async () => {
      vi.mocked(isPaymentServiceConfigured).mockReturnValue(false)

      await expect(billingService.createCheckout(USER, "pack_100")).rejects.toMatchObject({ statusCode: 503 })
      expect(fakeDb.model("PaymentIntent").docs).toHaveLength(0)
    })

    it("payment_service lỗi thì intent chuyển failed và lỗi được trả ra", async () => {
      vi.mocked(createPaymentOrder).mockRejectedValue(
        new ApiError(502, "Cổng thanh toán từ chối yêu cầu", "PAYMENT_SERVICE_ERROR")
      )

      await expect(billingService.createCheckout(USER, "pack_100")).rejects.toMatchObject({ statusCode: 502 })
      expect(fakeDb.model("PaymentIntent").docs[0].status).toBe("failed")
    })
  })

  describe("handlePaymentCallback", () => {
    it("paid + xác minh remote paid: cộng credit, ghi purchase, notify", async () => {
      await billingService.createCheckout(USER, "pack_100")
      vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder("order-1"))

      const result = await billingService.handlePaymentCallback({
        order_id: "order-1",
        status: "paid",
        client_id: CLIENT_ID
      })

      expect(getPaymentOrder).toHaveBeenCalledWith("order-1")
      expect(result).toEqual({ success: true, status: "succeeded", alreadyProcessed: false, creditsAdded: 100 })
      expect(walletOf()!.balance).toBe(planConfig.free.initialCredits + 100)
      expect(purchases()).toHaveLength(1)
      expect(notify).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "payment_success" }))
    })

    it("callback gọi lại cùng order_id không cộng lần hai", async () => {
      await billingService.createCheckout(USER, "pack_100")
      vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder("order-1"))
      const body = { order_id: "order-1", status: "paid", client_id: CLIENT_ID }

      await billingService.handlePaymentCallback(body)
      const replay = await billingService.handlePaymentCallback(body)

      expect(replay).toMatchObject({ alreadyProcessed: true, creditsAdded: 0 })
      expect(purchases()).toHaveLength(1)
      expect(walletOf()!.balance).toBe(planConfig.free.initialCredits + 100)
    })

    it("callback báo paid nhưng remote vẫn pending: KHÔNG cộng (callback chưa được ký)", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")
      vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder("order-1", { status: "pending", paid_at: null }))

      const result = await billingService.handlePaymentCallback({
        order_id: "order-1",
        status: "paid",
        client_id: CLIENT_ID
      })

      expect(result).toMatchObject({ status: "pending", creditsAdded: 0 })
      expect(intentDoc(intentId).status).toBe("pending")
      expect(purchases()).toHaveLength(0)
    })

    it("remote paid nhưng lệch số tiền: không cộng", async () => {
      await billingService.createCheckout(USER, "pack_100")
      vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder("order-1", { amount: 2_000 }))

      await billingService.handlePaymentCallback({ order_id: "order-1", status: "paid", client_id: CLIENT_ID })

      expect(purchases()).toHaveLength(0)
    })

    it("sai client_id → 403; order không có → 404", async () => {
      await billingService.createCheckout(USER, "pack_100")

      await expect(
        billingService.handlePaymentCallback({ order_id: "order-1", status: "paid", client_id: "other" })
      ).rejects.toMatchObject({ statusCode: 403 })
      await expect(
        billingService.handlePaymentCallback({ order_id: "order-x", status: "paid", client_id: CLIENT_ID })
      ).rejects.toMatchObject({ statusCode: 404 })
      expect(getPaymentOrder).not.toHaveBeenCalled()
    })

    it("remote failed: intent failed, notify payment_failed, không cộng", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")
      vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder("order-1", { status: "failed", paid_at: null }))

      await billingService.handlePaymentCallback({ order_id: "order-1", status: "failed", client_id: CLIENT_ID })

      expect(intentDoc(intentId).status).toBe("failed")
      expect(purchases()).toHaveLength(0)
      expect(notify).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "payment_failed" }))
    })
  })

  describe("getCheckout (polling)", () => {
    it("remote đã paid thì chốt luôn — fallback khi callback không tới", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")
      vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder("order-1"))

      const detail = await billingService.getCheckout(USER, intentId)

      expect(detail.status).toBe("succeeded")
      expect(walletOf()!.balance).toBe(planConfig.free.initialCredits + 100)
    })

    it("payment_service lỗi tạm thời: vẫn trả pending, không ném lỗi", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")
      vi.mocked(getPaymentOrder).mockRejectedValue(new ApiError(502, "down", "PAYMENT_SERVICE_UNAVAILABLE"))

      await expect(billingService.getCheckout(USER, intentId)).resolves.toMatchObject({ status: "pending" })
    })

    it("đã chốt thì không hỏi lại payment_service; intent người khác 404", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")
      vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder("order-1"))
      await billingService.getCheckout(USER, intentId)
      vi.mocked(getPaymentOrder).mockClear()

      await billingService.getCheckout(USER, intentId)

      expect(getPaymentOrder).not.toHaveBeenCalled()
      await expect(billingService.getCheckout(OTHER_USER, intentId)).rejects.toMatchObject({ statusCode: 404 })
    })

    it("callback và polling cùng chốt một order chỉ cộng một lần", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")
      vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder("order-1"))

      await Promise.all([
        billingService.getCheckout(USER, intentId),
        billingService.handlePaymentCallback({ order_id: "order-1", status: "paid", client_id: CLIENT_ID })
      ])

      expect(purchases()).toHaveLength(1)
    })
  })

  describe("upgrade / balance / transactions", () => {
    it("upgrade ghi Subscription và balance trả plan mới", async () => {
      const subscription = await billingService.upgradePlan(USER, "pro")

      expect(subscription).toMatchObject({
        plan: "pro",
        status: "active",
        monthlyCreditsAllotment: planConfig.pro.monthlyCredits
      })

      const balance = await billingService.getBalance(USER)
      expect(balance).toMatchObject({ plan: "pro", planLabel: "Pro", reserved: 0 })
      expect(notify).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "plan_changed" }))
    })

    it("upgrade lại cùng gói là idempotent (không notify lần hai)", async () => {
      await billingService.upgradePlan(USER, "pro")
      vi.mocked(notify).mockClear()
      await billingService.upgradePlan(USER, "pro")

      expect(fakeDb.model("Subscription").docs).toHaveLength(1)
      expect(notify).not.toHaveBeenCalled()
    })

    it("balance mặc định free và ledger tối đa 20 dòng mới nhất", async () => {
      await billingService.getBalance(USER)
      for (let i = 0; i < 25; i++) {
        await fakeDb.model("CreditTransaction").create({
          userId: new mongoose.Types.ObjectId(USER),
          type: "purchase",
          actionType: "purchase",
          amount: i,
          balanceAfter: i
        })
      }

      const balance = await billingService.getBalance(USER)
      expect(balance.plan).toBe("free")
      expect(balance.ledger).toHaveLength(20)
      expect(balance.ledger[0].amount).toBe(24)

      const page2 = await billingService.listTransactions(USER, 2, 20)
      expect(page2.items).toHaveLength(5)
      expect(page2.meta).toMatchObject({ total: 25, totalPages: 2 })
    })
  })
})

describe("billing routes (HTTP)", () => {
  let server: Server
  let baseUrl: string
  const token = signAccessToken({ userId: USER, email: "user@example.com" })

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use("/api/v1/billing", billingRoutes)
    app.use(errorHandler)
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once("listening", () => resolve()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/billing`
  })

  afterAll(() => {
    server.close()
  })

  beforeEach(setup)

  const postCallback = (body: object) =>
    fetch(`${baseUrl}/payment-callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })

  it("checkout → callback (không JWT) cộng credit một lần, trả { success: true }", async () => {
    const checkoutRes = await fetch(`${baseUrl}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ packageId: "pack_100" })
    })
    expect(checkoutRes.status).toBe(201)
    const { data: checkout } = await checkoutRes.json()
    expect(checkout.qrCodeUrl).toContain("vietqr")

    vi.mocked(getPaymentOrder).mockResolvedValue(remoteOrder("order-1"))
    const body = { order_id: "order-1", status: "paid", client_id: CLIENT_ID }

    const first = await postCallback(body)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ success: true, creditsAdded: 100 })

    const replay = await postCallback(body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ success: true, alreadyProcessed: true, creditsAdded: 0 })

    expect(walletOf()!.balance).toBe(planConfig.free.initialCredits + 100)

    const poll = await fetch(`${baseUrl}/checkout/${checkout.intentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    expect((await poll.json()).data.status).toBe("succeeded")
  })

  it("callback sai client_id 403, thiếu field 400", async () => {
    await billingService.createCheckout(USER, "pack_100")

    expect((await postCallback({ order_id: "order-1", status: "paid", client_id: "nope" })).status).toBe(403)
    expect((await postCallback({ order_id: "order-1" })).status).toBe(400)
  })

  it("các route người dùng yêu cầu auth", async () => {
    for (const path of ["/balance", "/packages", "/transactions", "/checkout/64b000000000000000000099"]) {
      const res = await fetch(`${baseUrl}${path}`)
      expect(res.status, path).toBe(401)
    }
  })

  it("upgrade với plan không hợp lệ trả 400", async () => {
    const res = await fetch(`${baseUrl}/upgrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan: "enterprise" })
    })
    expect(res.status).toBe(400)
  })
})
