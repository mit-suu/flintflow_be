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
vi.mock("../../modules/user/user.model.js", () => ({
  User: { findById: () => ({ lean: async () => ({ name: "Lan", email: "lan@example.com" }) }) }
}))
// FLF-310: ví = org — lượt gọi không gắn project dùng org đang chọn nếu còn là thành viên; có project thì org của project
const { membership, projectOrg } = vi.hoisted(() => ({ membership: { member: true }, projectOrg: { id: null as string | null } }))
vi.mock("../../modules/organization/membership.model.js", () => ({
  Membership: { exists: () => ({ session: async () => (membership.member ? { _id: "m1" } : null) }) }
}))
vi.mock("../../modules/project/project.model.js", () => ({
  Project: { findById: () => ({ lean: async () => (projectOrg.id === null ? { organizationId: null } : { organizationId: projectOrg.id }) }) }
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
  refundDeductedCredit,
  expireStaleReservations,
  getActionCost
} from "./credit-reservation.service.js"
import { ActionType, AiActionError } from "./ai-action.types.js"

const USER = "64b000000000000000000001"
const ORG = "64b0000000000000000000a1"
const PROJECT = "64b0000000000000000000b1"
const CHAT_COST = 2

const wallets = () => fakeDb.model("CreditWallet")
const ledger = () => fakeDb.model("CreditTransaction")
const walletOf = () => wallets().docs.find((w) => String(w.userId) === USER)!
const afterTtl = () => new Date(Date.now() + env.CREDIT_RESERVE_TTL_MS + 1_000)

describe("credit-reservation.service", () => {
  beforeEach(() => {
    fakeDb.reset()
    vi.clearAllMocks()
    membership.member = true
    projectOrg.id = null
  })

  it("FLF-265: translate_document tính 2 credit / lô", async () => {
    expect(await getActionCost(ActionType.TRANSLATE_DOCUMENT)).toBe(2)
  })

  describe("getOrCreateWallet", () => {
    it("tặng initialCredits từ plan.config (không cứng 100) và phát notification chào mừng", async () => {
      const wallet = await getOrCreateWallet(USER, undefined, ORG)

      expect(wallet.balance).toBe(planConfig.free.initialCredits)
      expect(wallet.reserved).toBe(0)
      expect(notify).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "welcome" }))
      // FLF-247: admin đọc tên/email, không đọc userId thô
      await vi.waitFor(() =>
        expect(notifyAdmins).toHaveBeenCalledWith(
          expect.objectContaining({ type: "admin_new_user", body: "Lan (lan@example.com) vừa bắt đầu sử dụng FlintFlow.", meta: { userId: USER } })
        )
      )
    })

    it("ví đã có thì không tạo lại và không notify lại", async () => {
      await getOrCreateWallet(USER, undefined, ORG)
      vi.clearAllMocks()
      await getOrCreateWallet(USER, undefined, ORG)

      expect(wallets().docs).toHaveLength(1)
      expect(notify).not.toHaveBeenCalled()
    })
  })

  describe("reserveCredit", () => {
    it("giữ credit, ghi state=reserved và expires_at = now + CREDIT_RESERVE_TTL_MS", async () => {
      const before = Date.now()
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)

      expect(reservation.cost).toBe(CHAT_COST)
      expect(walletOf().reserved).toBe(CHAT_COST)

      const row = ledger().docs.find((d) => String(d._id) === reservation.reservationId)!
      expect(row.type).toBe("reserve")
      expect(row.state).toBe("reserved")
      expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + env.CREDIT_RESERVE_TTL_MS)
      expect(row.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + env.CREDIT_RESERVE_TTL_MS)
    })

    it("không đủ credit khả dụng thì 402 và không đụng ví", async () => {
      await getOrCreateWallet(USER, undefined, ORG)
      walletOf().balance = 1

      await expect(reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)).rejects.toMatchObject({
        statusCode: 402,
        code: "INSUFFICIENT_CREDIT"
      })
      expect(walletOf().reserved).toBe(0)
      expect(ledger().docs).toHaveLength(0)
    })
  })

  describe("ví tổ chức (FLF-310 — bỏ ví cá nhân)", () => {
    it("không gắn project ⇒ trừ ví org đang chọn; ví mang organizationId, ledger cũng vậy", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      expect(reservation.organizationId).toBe(ORG)
      expect(String(walletOf().organizationId)).toBe(ORG)
      expect(String(ledger().docs[0].organizationId)).toBe(ORG)
    })

    it("có project ⇒ ví của org sở hữu project, bỏ qua org đang chọn", async () => {
      const PROJECT_ORG = "64b0000000000000000000a2"
      projectOrg.id = PROJECT_ORG
      const reservation = await reserveCredit(USER, ActionType.CHAT, PROJECT, undefined, ORG)
      expect(reservation.organizationId).toBe(PROJECT_ORG)
      expect(wallets().docs.map((w) => String(w.organizationId))).toEqual([PROJECT_ORG])
    })

    it("chưa chọn org / không còn là thành viên ⇒ 409 NO_ACTIVE_ORG, không tạo ví cá nhân", async () => {
      await expect(reserveCredit(USER, ActionType.CHAT)).rejects.toMatchObject({ statusCode: 409, code: "NO_ACTIVE_ORG" })
      membership.member = false
      await expect(reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)).rejects.toMatchObject({ code: "NO_ACTIVE_ORG" })
      expect(wallets().docs).toHaveLength(0)
    })

    it("project chưa thuộc org nào ⇒ 409 NO_WALLET_ORG", async () => {
      await expect(reserveCredit(USER, ActionType.CHAT, PROJECT, undefined, ORG)).rejects.toMatchObject({ statusCode: 409, code: "NO_WALLET_ORG" })
      expect(wallets().docs).toHaveLength(0)
    })

    it("hoàn khoản đã trừ không truyền org ⇒ hoàn về ví org của project (trước đây trượt sang ví cá nhân)", async () => {
      projectOrg.id = ORG
      const reservation = await reserveCredit(USER, ActionType.CHAT, PROJECT)
      await deductCredit(reservation)
      const before = walletOf().balance
      await refundDeductedCredit({ userId: USER, actionType: ActionType.DRAFT, amount: CHAT_COST, projectId: PROJECT })
      expect(walletOf().balance).toBe(before + CHAT_COST)
      expect(wallets().docs).toHaveLength(1)
    })
  })

  describe("expireStaleReservations", () => {
    it("reserve rồi hết hạn: trả reserved về ví, ghi state=expired và trả về số đã giải phóng", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
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
      await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)

      expect(await expireStaleReservations(new Date())).toEqual({ expiredCount: 0, releasedCredits: 0 })
      expect(walletOf().reserved).toBe(CHAT_COST)

      await expireStaleReservations(afterTtl())
      expect(await expireStaleReservations(afterTtl())).toEqual({ expiredCount: 0, releasedCredits: 0 })
      expect(walletOf().reserved).toBe(0)
    })

    it("không đụng reservation đã deducted", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      await deductCredit(reservation)

      expect(await expireStaleReservations(afterTtl())).toEqual({ expiredCount: 0, releasedCredits: 0 })
    })
  })

  describe("deductCredit / releaseCredit", () => {
    it("deduct trừ balance và reserved đúng một lần (idempotent)", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      const balanceBefore = walletOf().balance

      await deductCredit(reservation)
      await deductCredit(reservation)

      expect(walletOf().balance).toBe(balanceBefore - CHAT_COST)
      expect(walletOf().reserved).toBe(0)
      expect(ledger().docs.filter((d) => d.type === "deduct")).toHaveLength(1)
    })

    it("release sau deduct là no-op (sửa lỗi deduct rồi lại release)", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      await deductCredit(reservation)
      const snapshot = { ...walletOf() }

      expect(await releaseCredit(reservation)).toBe(false)
      expect(walletOf().balance).toBe(snapshot.balance)
      expect(walletOf().reserved).toBe(snapshot.reserved)
      expect(ledger().docs.filter((d) => d.type === "release")).toHaveLength(0)
    })

    it("release trả reserved, ghi state=refunded; release lần hai không làm reserved âm", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)

      expect(await releaseCredit(reservation)).toBe(true)
      expect(await releaseCredit(reservation)).toBe(false)

      expect(walletOf().reserved).toBe(0)
      const row = ledger().docs.find((d) => String(d._id) === reservation.reservationId)!
      expect(row.state).toBe("refunded")
    })

    it("release sau khi cron đã expire không trả lại lần hai", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      await expireStaleReservations(afterTtl())

      expect(await releaseCredit(reservation)).toBe(false)
      expect(walletOf().reserved).toBe(0)
    })

    it("deduct sau khi expire vẫn tính phí nhưng chỉ trừ balance", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      const balanceBefore = walletOf().balance
      await expireStaleReservations(afterTtl())

      await deductCredit(reservation)

      expect(walletOf().balance).toBe(balanceBefore - CHAT_COST)
      expect(walletOf().reserved).toBe(0)
    })

    it("deduct trên reservation đã refunded thì báo lỗi thay vì âm thầm trừ", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      await releaseCredit(reservation)

      await expect(deductCredit(reservation)).rejects.toBeInstanceOf(AiActionError)
    })

    it("notify low_credit đúng một lần khi balance vượt xuống dưới ngưỡng", async () => {
      await getOrCreateWallet(USER, undefined, ORG)
      walletOf().balance = planConfig.lowCreditThreshold + 1
      vi.clearAllMocks()

      const first = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      await deductCredit(first)
      const second = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      await deductCredit(second)

      const lowCreditCalls = vi
        .mocked(notify)
        .mock.calls.filter(([, payload]) => payload.type === "low_credit")
      expect(lowCreditCalls).toHaveLength(1)
    })

    it("ví không khớp khi deduct: báo lỗi, reservation trở lại reserved và release vẫn trả được credit", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      // vd admin trừ credit giữa lúc AI đang chạy
      walletOf().balance = 0

      await expect(deductCredit(reservation)).rejects.toMatchObject({ code: "CREDIT_LEDGER_INCONSISTENT" })
      const row = ledger().docs.find((d) => String(d._id) === reservation.reservationId)!
      expect(row.state).toBe("reserved")
      expect(ledger().docs.filter((d) => d.type === "deduct")).toHaveLength(0)

      expect(await releaseCredit(reservation)).toBe(true)
      expect(walletOf().reserved).toBe(0)
    })

    it("deduct sau expire chỉ trừ trên số khả dụng và không trừ hai lần", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      await expireStaleReservations(afterTtl())
      // reservation khác đang giữ hết số khả dụng
      walletOf().reserved = walletOf().balance

      await expect(deductCredit(reservation)).rejects.toMatchObject({ code: "CREDIT_LEDGER_INCONSISTENT" })
      expect(ledger().docs.find((d) => String(d._id) === reservation.reservationId)!.state).toBe("expired")

      walletOf().reserved = 0
      const balanceBefore = walletOf().balance
      await deductCredit(reservation)
      await deductCredit(reservation)

      expect(walletOf().balance).toBe(balanceBefore - CHAT_COST)
      expect(ledger().docs.filter((d) => d.type === "deduct")).toHaveLength(1)
    })
  })

  describe("refundDeductedCredit", () => {
    it("cộng lại số dư đã trừ và ghi dòng type=refund", async () => {
      const reservation = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      await deductCredit(reservation)
      const balanceAfterDeduct = walletOf().balance

      await refundDeductedCredit({ userId: USER, organizationId: ORG, actionType: ActionType.DRAFT, amount: CHAT_COST })

      expect(walletOf().balance).toBe(balanceAfterDeduct + CHAT_COST)
      const row = ledger().docs.find((d) => d.type === "refund")!
      expect(row.amount).toBe(CHAT_COST)
      expect(row.balanceAfter).toBe(walletOf().balance - walletOf().reserved)
    })

    it("amount = 0 thì không đụng ví", async () => {
      await getOrCreateWallet(USER, undefined, ORG)
      const before = walletOf().balance
      await refundDeductedCredit({ userId: USER, organizationId: ORG, actionType: ActionType.DRAFT, amount: 0 })
      expect(walletOf().balance).toBe(before)
      expect(ledger().docs.some((d) => d.type === "refund")).toBe(false)
    })
  })
})
