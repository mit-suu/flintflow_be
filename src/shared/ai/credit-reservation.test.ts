import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("../../modules/credits/credit-wallet.model.js", async () => {
  const { fakeDb } = await import("../../modules/billing/__tests__/fake-mongo.js")
  return { CreditWallet: fakeDb.model("CreditWallet") }
})
vi.mock("../../modules/credits/credit-transaction.model.js", async () => {
  const { fakeDb } = await import("../../modules/billing/__tests__/fake-mongo.js")
  return { CreditTransaction: fakeDb.model("CreditTransaction") }
})
vi.mock("../../modules/admin/pricing-config.model.js", () => ({
  PricingConfig: { findOne: async () => null }
}))
vi.mock("../../modules/notification/notification.service.js", () => ({
  notify: vi.fn(async () => null),
  notifyAdmins: vi.fn(async () => 0)
}))

import { fakeDb } from "../../modules/billing/__tests__/fake-mongo.js"
import { notify, notifyAdmins } from "../../modules/notification/notification.service.js"
import { planConfig } from "../../modules/billing/plan.config.js"
import { env } from "../../config/env.js"
import {
  getOrCreateWallet,
  reserveCredit,
  deductCredit,
  releaseCredit,
  expireStaleReservations
} from "./credit-reservation.service.js"
import { ActionType, AiActionError } from "./ai-action.types.js"

const USER = "64b000000000000000000001"
const CHAT_COST = 2

const wallets = () => fakeDb.model("CreditWallet")
const ledger = () => fakeDb.model("CreditTransaction")
const walletOf = () => wallets().docs.find((w) => String(w.userId) === USER)!
const afterTtl = () => new Date(Date.now() + env.CREDIT_RESERVE_TTL_MS + 1_000)

describe("credit-reservation.service", () => {
  beforeEach(() => {
    fakeDb.reset()
    vi.clearAllMocks()
  })

  describe("getOrCreateWallet", () => {
    it("tặng initialCredits từ plan.config (không cứng 100) và phát notification chào mừng", async () => {
      const wallet = await getOrCreateWallet(USER)

      expect(wallet.balance).toBe(planConfig.free.initialCredits)
      expect(wallet.reserved).toBe(0)
      expect(notify).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "welcome" }))
      expect(notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: "admin_new_user" }))
    })

    it("ví đã có thì không tạo lại và không notify lại", async () => {
      await getOrCreateWallet(USER)
      vi.clearAllMocks()
      await getOrCreateWallet(USER)

      expect(wallets().docs).toHaveLength(1)
      expect(notify).not.toHaveBeenCalled()
    })
  })

  describe("reserveCredit", () => {
    it("giữ credit, ghi state=reserved và expires_at = now + CREDIT_RESERVE_TTL_MS", async () => {
      const before = Date.now()
      const reservation = await reserveCredit(USER, ActionType.CHAT)

      expect(reservation.cost).toBe(CHAT_COST)
      expect(walletOf().reserved).toBe(CHAT_COST)

      const row = ledger().docs.find((d) => String(d._id) === reservation.reservationId)!
      expect(row.type).toBe("reserve")
      expect(row.state).toBe("reserved")
      expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + env.CREDIT_RESERVE_TTL_MS)
      expect(row.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + env.CREDIT_RESERVE_TTL_MS)
    })

    it("không đủ credit khả dụng thì 402 và không đụng ví", async () => {
      await getOrCreateWallet(USER)
      walletOf().balance = 1

      await expect(reserveCredit(USER, ActionType.CHAT)).rejects.toMatchObject({
        statusCode: 402,
        code: "INSUFFICIENT_CREDIT"
      })
      expect(walletOf().reserved).toBe(0)
      expect(ledger().docs).toHaveLength(0)
    })
  })

  describe("expireStaleReservations", () => {
    it("reserve rồi hết hạn: trả reserved về ví, ghi state=expired và trả về số đã giải phóng", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT)
      const balanceBefore = walletOf().balance

      const result = await expireStaleReservations(afterTtl())

      expect(result).toEqual({ expiredCount: 1, releasedCredits: CHAT_COST })
      expect(walletOf().reserved).toBe(0)
      expect(walletOf().balance).toBe(balanceBefore)

      const row = ledger().docs.find((d) => String(d._id) === reservation.reservationId)!
      expect(row.state).toBe("expired")

      const release = ledger().docs.find((d) => d.type === "release")!
      expect(String(release.reservationId)).toBe(reservation.reservationId)
    })

    it("không đụng reservation chưa hết hạn và không expire hai lần", async () => {
      await reserveCredit(USER, ActionType.CHAT)

      expect(await expireStaleReservations(new Date())).toEqual({ expiredCount: 0, releasedCredits: 0 })
      expect(walletOf().reserved).toBe(CHAT_COST)

      await expireStaleReservations(afterTtl())
      expect(await expireStaleReservations(afterTtl())).toEqual({ expiredCount: 0, releasedCredits: 0 })
      expect(walletOf().reserved).toBe(0)
    })

    it("không đụng reservation đã deducted", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT)
      await deductCredit(reservation)

      expect(await expireStaleReservations(afterTtl())).toEqual({ expiredCount: 0, releasedCredits: 0 })
    })
  })

  describe("deductCredit / releaseCredit", () => {
    it("deduct trừ balance và reserved đúng một lần (idempotent)", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT)
      const balanceBefore = walletOf().balance

      await deductCredit(reservation)
      await deductCredit(reservation)

      expect(walletOf().balance).toBe(balanceBefore - CHAT_COST)
      expect(walletOf().reserved).toBe(0)
      expect(ledger().docs.filter((d) => d.type === "deduct")).toHaveLength(1)
    })

    it("release sau deduct là no-op (sửa lỗi deduct rồi lại release)", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT)
      await deductCredit(reservation)
      const snapshot = { ...walletOf() }

      expect(await releaseCredit(reservation)).toBe(false)
      expect(walletOf().balance).toBe(snapshot.balance)
      expect(walletOf().reserved).toBe(snapshot.reserved)
      expect(ledger().docs.filter((d) => d.type === "release")).toHaveLength(0)
    })

    it("release trả reserved, ghi state=refunded; release lần hai không làm reserved âm", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT)

      expect(await releaseCredit(reservation)).toBe(true)
      expect(await releaseCredit(reservation)).toBe(false)

      expect(walletOf().reserved).toBe(0)
      const row = ledger().docs.find((d) => String(d._id) === reservation.reservationId)!
      expect(row.state).toBe("refunded")
    })

    it("release sau khi cron đã expire không trả lại lần hai", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT)
      await expireStaleReservations(afterTtl())

      expect(await releaseCredit(reservation)).toBe(false)
      expect(walletOf().reserved).toBe(0)
    })

    it("deduct sau khi expire vẫn tính phí nhưng chỉ trừ balance", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT)
      const balanceBefore = walletOf().balance
      await expireStaleReservations(afterTtl())

      await deductCredit(reservation)

      expect(walletOf().balance).toBe(balanceBefore - CHAT_COST)
      expect(walletOf().reserved).toBe(0)
    })

    it("deduct trên reservation đã refunded thì báo lỗi thay vì âm thầm trừ", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT)
      await releaseCredit(reservation)

      await expect(deductCredit(reservation)).rejects.toBeInstanceOf(AiActionError)
    })

    it("notify low_credit đúng một lần khi balance vượt xuống dưới ngưỡng", async () => {
      await getOrCreateWallet(USER)
      walletOf().balance = planConfig.lowCreditThreshold + 1
      vi.clearAllMocks()

      const first = await reserveCredit(USER, ActionType.CHAT)
      await deductCredit(first)
      const second = await reserveCredit(USER, ActionType.CHAT)
      await deductCredit(second)

      const lowCreditCalls = vi
        .mocked(notify)
        .mock.calls.filter(([, payload]) => payload.type === "low_credit")
      expect(lowCreditCalls).toHaveLength(1)
    })
  })
})
