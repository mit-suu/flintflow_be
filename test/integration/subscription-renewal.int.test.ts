/**
 * UC-80 (FLF-309) — sang kỳ mới cho gói hết hạn: Pro về Free, nạp ví tới hạn mức của gói, chạy lại không cộng hai lần.
 */
import { describe, it, expect } from "vitest"
import mongoose from "mongoose"
import { Subscription } from "../../src/modules/credits/subscription.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { CreditTransaction } from "../../src/modules/credits/credit-transaction.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { planConfig } from "../../src/modules/billing/plan.config.js"
import { renewDueSubscriptions } from "../../src/modules/billing/subscription-renewal.service.js"

const DAY = 86_400_000
const NOW = new Date("2026-11-01T00:00:00.000Z")

const seedOrg = async (opts: { plan: "free" | "pro"; periodEnd: Date; balance: number }) => {
  const userId = new mongoose.Types.ObjectId()
  const organizationId = new mongoose.Types.ObjectId()
  await CreditWallet.create({ userId, organizationId, balance: opts.balance, reserved: 0 })
  const sub = await Subscription.create({
    userId,
    organizationId,
    plan: opts.plan,
    status: "active",
    monthlyCreditsAllotment: planConfig[opts.plan].monthlyCredits,
    currentPeriodStart: new Date(opts.periodEnd.getTime() - planConfig.periodDays * DAY),
    currentPeriodEnd: opts.periodEnd
  })
  return { userId, organizationId, subId: sub._id }
}

const walletOf = (organizationId: mongoose.Types.ObjectId) => CreditWallet.findOne({ organizationId }).lean()

describe("UC-80 — Billing Scheduler", () => {
  it("Pro hết kỳ ⇒ về Free, nạp ví tới hạn mức Free, thông báo plan_expired", async () => {
    const { userId, organizationId, subId } = await seedOrg({ plan: "pro", periodEnd: new Date(NOW.getTime() - DAY), balance: 40 })

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 0, downgraded: 1, creditsGranted: planConfig.free.monthlyCredits - 40 })
    const sub = await Subscription.findById(subId).lean()
    expect(sub?.plan).toBe("free")
    expect(sub?.status).toBe("active")
    expect(sub?.monthlyCreditsAllotment).toBe(planConfig.free.monthlyCredits)
    expect(sub?.currentPeriodEnd.getTime()).toBeGreaterThan(NOW.getTime())
    expect((await walletOf(organizationId))?.balance).toBe(planConfig.free.monthlyCredits)

    const notes = await Notification.find({ userId }).lean()
    expect(notes.map((n) => n.type)).toEqual(["plan_expired"])
    expect(String(notes[0].organizationId)).toBe(String(organizationId))
  })

  it("Free hết kỳ ⇒ kỳ mới nối tiếp kỳ cũ, ghi giao dịch monthly_reset", async () => {
    const periodEnd = new Date(NOW.getTime() - 2 * DAY)
    const { organizationId, subId } = await seedOrg({ plan: "free", periodEnd, balance: 120 })

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 1, downgraded: 0, creditsGranted: planConfig.free.monthlyCredits - 120 })
    const sub = await Subscription.findById(subId).lean()
    expect(sub?.currentPeriodStart.getTime()).toBe(periodEnd.getTime())
    expect(sub?.currentPeriodEnd.getTime()).toBe(periodEnd.getTime() + planConfig.periodDays * DAY)

    const txs = await CreditTransaction.find({ organizationId }).lean()
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({ type: "monthly_reset", amount: planConfig.free.monthlyCredits - 120 })
    expect((await walletOf(organizationId))?.balance).toBe(planConfig.free.monthlyCredits)
  })

  it("ví đang nhiều hơn hạn mức ⇒ giữ nguyên số dư, không ghi giao dịch", async () => {
    const { organizationId } = await seedOrg({ plan: "free", periodEnd: new Date(NOW.getTime() - DAY), balance: 500 })

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 1, downgraded: 0, creditsGranted: 0 })
    expect((await walletOf(organizationId))?.balance).toBe(500)
    expect(await CreditTransaction.countDocuments({ organizationId })).toBe(0)
  })

  it("chạy hai lần liên tiếp không cộng credit hai lần", async () => {
    const { organizationId } = await seedOrg({ plan: "free", periodEnd: new Date(NOW.getTime() - DAY), balance: 0 })

    await renewDueSubscriptions(NOW)
    const second = await renewDueSubscriptions(NOW)

    expect(second).toEqual({ renewed: 0, downgraded: 0, creditsGranted: 0 })
    expect((await walletOf(organizationId))?.balance).toBe(planConfig.free.monthlyCredits)
    expect(await CreditTransaction.countDocuments({ organizationId, type: "monthly_reset" })).toBe(1)
  })

  it("gói chưa tới hạn không bị đổi", async () => {
    const periodEnd = new Date(NOW.getTime() + 5 * DAY)
    const { organizationId, subId } = await seedOrg({ plan: "pro", periodEnd, balance: 10 })

    expect(await renewDueSubscriptions(NOW)).toEqual({ renewed: 0, downgraded: 0, creditsGranted: 0 })
    const sub = await Subscription.findById(subId).lean()
    expect(sub?.plan).toBe("pro")
    expect(sub?.currentPeriodEnd.getTime()).toBe(periodEnd.getTime())
    expect((await walletOf(organizationId))?.balance).toBe(10)
  })
})
