import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("../../modules/credits/credit-wallet.model.js", async () => {
  const { fakeDb } = await import("../../modules/billing/__tests__/fake-mongo.js")
  return { CreditWallet: fakeDb.model("CreditWallet") }
})
vi.mock("../../modules/credits/credit-transaction.model.js", async () => {
  const { fakeDb } = await import("../../modules/billing/__tests__/fake-mongo.js")
  return { CreditTransaction: fakeDb.model("CreditTransaction") }
})
vi.mock("../../modules/user/user.model.js", () => ({
  User: { findById: () => ({ lean: async () => ({ name: "Lan", email: "lan@example.com" }) }) }
}))
// FLF-310: ví = org — lượt gọi không gắn project dùng org đang chọn nếu còn là thành viên; có project thì org của project
const { membership, projectOrg } = vi.hoisted(() => ({
  membership: { member: true, leads: [] as Array<{ userId: string }> },
  projectOrg: { id: null as string | null }
}))
vi.mock("../../modules/organization/membership.model.js", () => ({
  Membership: {
    exists: () => ({ session: async () => (membership.member ? { _id: "m1" } : null) }),
    find: vi.fn(() => ({ select: () => ({ lean: async () => membership.leads }) }))
  }
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
import { Membership } from "../../modules/organization/membership.model.js"
import {
  getOrCreateWallet,
  reserveCredit,
  deductCredit,
  releaseCredit,
  refundDeductedCredit,
  expireStaleReservations,
  getActionCost,
  calculateActualCreditCost,
  TOKEN_CREDIT_WEIGHTS
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
    membership.leads = []
    projectOrg.id = null
  })

  it("FLF-333: knowledge_answer 0 credit - reserve không đụng ví / sổ, deduct và release là no-op", async () => {
    expect(await getActionCost(ActionType.KNOWLEDGE_ANSWER)).toBe(0)
    await getOrCreateWallet(USER, undefined, ORG)
    const balanceBefore = walletOf().balance
    const entries = ledger().docs.length
    const reservation = await reserveCredit(USER, ActionType.KNOWLEDGE_ANSWER, undefined, undefined, ORG)
    expect(reservation).toMatchObject({ cost: 0, actionType: ActionType.KNOWLEDGE_ANSWER, organizationId: ORG })
    expect(reservation.reservationId).toMatch(/^[0-9a-f]{24}$/)
    expect(walletOf()).toMatchObject({ balance: balanceBefore, reserved: 0 })
    await deductCredit(reservation)
    expect(await releaseCredit(reservation)).toBe(true)
    expect(walletOf()).toMatchObject({ balance: balanceBefore, reserved: 0 })
    expect(ledger().docs.length).toBe(entries)
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

  describe("ví tổ chức (FLF-310 - bỏ ví cá nhân)", () => {
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

  describe("step + token trên sổ (UC-60)", () => {
    it("deduct ghi step và token lên dòng deduct và dòng reserve; release giữ step", async () => {
      const ok = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG, "S-2.1")
      await deductCredit(ok, undefined, { tokensIn: 900, tokensOut: 150 })
      const failed = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG, "S-2.2")
      await releaseCredit(failed)

      const reserveRow = ledger().docs.find((d) => String(d._id) === ok.reservationId)!
      const deductRow = ledger().docs.find((d) => d.type === "deduct")!
      const releaseRow = ledger().docs.find((d) => d.type === "release")!
      expect(reserveRow).toMatchObject({ state: "deducted", stepId: "S-2.1", tokensIn: 900, tokensOut: 150 })
      expect(deductRow).toMatchObject({ stepId: "S-2.1", tokensIn: 900, tokensOut: 150 })
      expect(releaseRow).toMatchObject({ stepId: "S-2.2" })
    })

    it("chuẩn hoá token âm / số thập phân / NaN về số nguyên >= 0 khi lưu sổ", async () => {
      const ok = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG, "S-2.3")
      await deductCredit(ok, undefined, { tokensIn: -50.8, tokensOut: 120.9 })
      const reserveRow = ledger().docs.find((d) => String(d._id) === ok.reservationId)!
      const deductRow = ledger().docs.find((d) => d.type === "deduct" && d.stepId === "S-2.3")!
      expect(reserveRow).toMatchObject({ tokensIn: 0, tokensOut: 120 })
      expect(deductRow).toMatchObject({ tokensIn: 0, tokensOut: 120 })

      const nanCase = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG, "S-2.4")
      await deductCredit(nanCase, undefined, { tokensIn: Number.NaN, tokensOut: Number.POSITIVE_INFINITY })
      const nanReserve = ledger().docs.find((d) => String(d._id) === nanCase.reservationId)!
      const nanDeduct = ledger().docs.find((d) => d.type === "deduct" && d.stepId === "S-2.4")!
      expect(nanReserve).toMatchObject({ tokensIn: 0, tokensOut: 0 })
      expect(nanDeduct).toMatchObject({ tokensIn: 0, tokensOut: 0 })
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

  describe("quyết toán theo token thực tế & bảng giá server (FLF-417)", () => {
    it("DRAFT giữ 4 credit, gọi tốn 900 in / 150 out ⇒ trừ 1 credit, hoàn 3 hold về available, trả actualCost = 1", async () => {
      const initial = planConfig.free.initialCredits
      const res = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG, "S-2.1")
      expect(res.cost).toBe(4)
      expect(walletOf()).toMatchObject({ balance: initial, reserved: 4 })

      const settled = await deductCredit(res, undefined, { tokensIn: 900, tokensOut: 150 })

      expect(settled).toBe(1)
      expect(walletOf()).toMatchObject({ balance: initial - 1, reserved: 0 })
      const deductRow = ledger().docs.find((d) => d.type === "deduct")!
      expect(deductRow).toMatchObject({ amount: 1, balanceAfter: initial - 1, tokensIn: 900, tokensOut: 150 })

      // Idempotent re-call returns the already-settled actualCost without deducting again
      expect(await deductCredit(res)).toBe(1)
      expect(walletOf()).toMatchObject({ balance: initial - 1, reserved: 0 })
      expect(ledger().docs.filter((d) => d.type === "deduct")).toHaveLength(1)
    })

    it("token cao vượt mức ước lượng (10k in / 8k out) ⇒ trần ở mức đã reserve (4 credit), không lẹm sang hold khác", async () => {
      const initial = planConfig.free.initialCredits
      const otherHold = await reserveCredit(USER, ActionType.CHAT, undefined, undefined, ORG)
      const res = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG)
      expect(walletOf()).toMatchObject({ balance: initial, reserved: otherHold.cost + 4 })

      const settled = await deductCredit(res, undefined, { tokensIn: 10_000, tokensOut: 8_000 })
      expect(settled).toBe(4)
      expect(walletOf()).toMatchObject({ balance: initial - 4, reserved: otherHold.cost })
    })

    it("token = 0 / không truyền token / token âm: miễn phí trả 0, có phí tối thiểu 1 và giữ nguyên khi không truyền token", () => {
      expect(TOKEN_CREDIT_WEIGHTS).toEqual({ inputPer1k: 0.25, outputPer1k: 1.0 })
      expect(calculateActualCreditCost(0, { tokensIn: 0, tokensOut: 0 })).toBe(0)
      expect(calculateActualCreditCost(4, { tokensIn: 0, tokensOut: 0 })).toBe(1)
      expect(calculateActualCreditCost(4, { tokensIn: -100, tokensOut: -50 })).toBe(1)
      expect(calculateActualCreditCost(4, undefined)).toBe(4)
    })

    it("reservation đã hết hạn TTL trước khi deduct hoàn tất ⇒ chỉ trừ actualCost khỏi balance, reserved giữ nguyên 0", async () => {
      const initial = planConfig.free.initialCredits
      const res = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG)
      await expireStaleReservations(afterTtl())
      expect(walletOf()).toMatchObject({ balance: initial, reserved: 0 })

      const settled = await deductCredit(res, undefined, { tokensIn: 400, tokensOut: 100 })
      expect(settled).toBe(1)
      expect(walletOf()).toMatchObject({ balance: initial - 1, reserved: 0 })
      const deductRow = ledger().docs.find((d) => d.type === "deduct")!
      expect(deductRow).toMatchObject({ amount: 1, balanceAfter: initial - 1, tokensIn: 400, tokensOut: 100 })
    })

    it("low_credit báo mọi Lead của org (loại trùng, gắn organizationId); không có Lead thì lùi về fallback user", async () => {
      const LEAD_A = "64b0000000000000000000e1"
      const LEAD_B = "64b0000000000000000000e2"
      membership.leads = [{ userId: LEAD_A }, { userId: LEAD_B }, { userId: LEAD_A }]
      await getOrCreateWallet(USER, undefined, ORG)
      walletOf().balance = planConfig.lowCreditThreshold + 1
      vi.clearAllMocks()

      // Available drops from 11 -> 10 after returning unused hold (actualCost = 1 < reserved = 4): must NOT notify yet
      const beforeThreshold = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG)
      await deductCredit(beforeThreshold, undefined, { tokensIn: 400, tokensOut: 100 })
      expect(vi.mocked(notify).mock.calls.filter(([, p]) => p.type === "low_credit")).toHaveLength(0)

      // Available drops from 10 -> 9: notifies deduplicated org Leads with organizationId
      const crossesThreshold = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG)
      await deductCredit(crossesThreshold, undefined, { tokensIn: 400, tokensOut: 100 })

      const leadCalls = vi.mocked(notify).mock.calls.filter(([, p]) => p.type === "low_credit")
      expect(Membership.find).toHaveBeenCalledWith({ organizationId: ORG, role: "lead" })
      expect(leadCalls.map(([uid]) => uid).sort()).toEqual([LEAD_A, LEAD_B].sort())
      expect(leadCalls.every(([, p]) => p.organizationId === ORG)).toBe(true)

      // Fallback when org has zero Lead memberships
      membership.leads = []
      walletOf().balance = planConfig.lowCreditThreshold
      vi.clearAllMocks()
      const fallbackCall = await reserveCredit(USER, ActionType.DRAFT, undefined, undefined, ORG)
      await deductCredit(fallbackCall, undefined, { tokensIn: 400, tokensOut: 100 })
      const fallbackCalls = vi.mocked(notify).mock.calls.filter(([, p]) => p.type === "low_credit")
      expect(fallbackCalls).toHaveLength(1)
      expect(fallbackCalls[0][0]).toBe(USER)
      expect(fallbackCalls[0][1].organizationId).toBe(ORG)
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
