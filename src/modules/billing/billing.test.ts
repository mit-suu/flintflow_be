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

import { fakeDb, TRANSACTION_UNSUPPORTED } from "./__tests__/fake-mongo.js"
import { notify } from "../notification/notification.service.js"
import { errorHandler } from "../../shared/middlewares/error-handler.js"
import { signAccessToken } from "../../shared/auth/jwt.util.js"
import billingRoutes from "./billing.route.js"
import * as billingService from "./billing.service.js"
import { planConfig } from "./plan.config.js"

const USER = "64b000000000000000000002"
const OTHER_USER = "64b000000000000000000003"

const walletOf = (userId = USER) =>
  fakeDb.model("CreditWallet").docs.find((w) => String(w.userId) === userId)
const purchases = () => fakeDb.model("CreditTransaction").docs.filter((d) => d.type === "purchase")

describe("billing.service", () => {
  beforeEach(() => {
    fakeDb.reset()
    vi.clearAllMocks()
    vi.spyOn(mongoose, "startSession").mockRejectedValue(TRANSACTION_UNSUPPORTED)
  })

  describe("checkout", () => {
    it("tạo PaymentIntent pending với số tiền/credit của gói và redirectUrl mock", async () => {
      const checkout = await billingService.createCheckout(USER, "pack_100")

      expect(checkout).toMatchObject({ status: "pending", credits: 100, amount: 49_000 })
      expect(checkout.redirectUrl).toContain(`intentId=${checkout.intentId}`)
    })

    it("gói không tồn tại thì 404", async () => {
      await expect(billingService.createCheckout(USER, "pack_nope")).rejects.toMatchObject({
        statusCode: 404
      })
    })

    it("getCheckout chỉ trả intent của chính chủ, kèm chữ ký hợp lệ khi pending", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")

      const detail = await billingService.getCheckout(USER, intentId)
      expect(
        billingService.verifyMockWebhookSignature(intentId, "success", detail.mockSignatures!.success)
      ).toBe(true)

      await expect(billingService.getCheckout(OTHER_USER, intentId)).rejects.toMatchObject({
        statusCode: 404
      })
    })
  })

  describe("handleMockWebhook", () => {
    it("chữ ký đúng + success: cộng credit, ghi purchase, notify", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_500")
      const signature = billingService.signMockWebhook(intentId, "success")

      const result = await billingService.handleMockWebhook(intentId, "success", signature)

      expect(result).toMatchObject({ status: "succeeded", alreadyProcessed: false, creditsAdded: 500 })
      expect(walletOf()!.balance).toBe(planConfig.free.initialCredits + 500)
      expect(purchases()).toHaveLength(1)
      expect(notify).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "payment_success" }))
    })

    it("chữ ký sai hoặc thiếu: 401, không cộng credit", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")

      await expect(
        billingService.handleMockWebhook(intentId, "success", "deadbeef")
      ).rejects.toMatchObject({ statusCode: 401, code: "INVALID_WEBHOOK_SIGNATURE" })
      await expect(
        billingService.handleMockWebhook(intentId, "success", undefined)
      ).rejects.toMatchObject({ statusCode: 401 })

      expect(purchases()).toHaveLength(0)
    })

    it("chữ ký của 'failed' không dùng được cho 'success'", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")
      const failedSig = billingService.signMockWebhook(intentId, "failed")

      await expect(
        billingService.handleMockWebhook(intentId, "success", failedSig)
      ).rejects.toMatchObject({ statusCode: 401 })
    })

    it("gửi lại cùng intentId không cộng lần hai", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")
      const signature = billingService.signMockWebhook(intentId, "success")

      await billingService.handleMockWebhook(intentId, "success", signature)
      const replay = await billingService.handleMockWebhook(intentId, "success", signature)

      expect(replay).toMatchObject({ alreadyProcessed: true, creditsAdded: 0, status: "succeeded" })
      expect(walletOf()!.balance).toBe(planConfig.free.initialCredits + 100)
      expect(purchases()).toHaveLength(1)
    })

    it("failed: không cộng credit, notify payment_failed, success sau đó bị bỏ qua", async () => {
      const { intentId } = await billingService.createCheckout(USER, "pack_100")

      await billingService.handleMockWebhook(
        intentId,
        "failed",
        billingService.signMockWebhook(intentId, "failed")
      )
      const late = await billingService.handleMockWebhook(
        intentId,
        "success",
        billingService.signMockWebhook(intentId, "success")
      )

      expect(late.alreadyProcessed).toBe(true)
      expect(purchases()).toHaveLength(0)
      expect(notify).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "payment_failed" }))
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
      vi.clearAllMocks()
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

  beforeEach(() => {
    fakeDb.reset()
    vi.spyOn(mongoose, "startSession").mockRejectedValue(TRANSACTION_UNSUPPORTED)
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  const postWebhook = (body: object, signature?: string) =>
    fetch(`${baseUrl}/webhook/mock`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signature ? { "x-mock-signature": signature } : {})
      },
      body: JSON.stringify(body)
    })

  it("webhook: chữ ký đúng cộng credit, sai chữ ký 401, replay không cộng lần hai", async () => {
    const checkoutRes = await fetch(`${baseUrl}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ packageId: "pack_100" })
    })
    expect(checkoutRes.status).toBe(201)
    const { data: checkout } = await checkoutRes.json()

    const body = { intentId: checkout.intentId, status: "success" }
    const signature = billingService.signMockWebhook(checkout.intentId, "success")

    const bad = await postWebhook(body, "00".repeat(32))
    expect(bad.status).toBe(401)
    expect(walletOf()?.balance ?? 0).toBe(0)

    const ok = await postWebhook(body, signature)
    expect(ok.status).toBe(200)
    expect((await ok.json()).data).toMatchObject({ creditsAdded: 100, alreadyProcessed: false })

    const replay = await postWebhook(body, signature)
    expect(replay.status).toBe(200)
    expect((await replay.json()).data).toMatchObject({ creditsAdded: 0, alreadyProcessed: true })

    expect(walletOf()!.balance).toBe(planConfig.free.initialCredits + 100)
  })

  it("webhook: chữ ký trong body cũng được chấp nhận; payload sai trả 400", async () => {
    const { intentId } = await billingService.createCheckout(USER, "pack_100")

    const ok = await postWebhook({
      intentId,
      status: "failed",
      signature: billingService.signMockWebhook(intentId, "failed")
    })
    expect(ok.status).toBe(200)

    const invalid = await postWebhook({ intentId: "not-an-id", status: "success" })
    expect(invalid.status).toBe(400)
  })

  it("các route còn lại yêu cầu auth", async () => {
    for (const path of ["/balance", "/packages", "/transactions"]) {
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
