/**
 * UC-80 (FLF-309 / FLF-417) — sang kỳ mới cho gói hết hạn: Pro về Free, cộng dồn đủ hạn mức kỳ mới
 * bất kể số dư hiện tại, thông báo toàn bộ Lead của tổ chức, chạy lại không cộng hai lần.
 */
import { describe, it, expect } from "vitest"
import mongoose from "mongoose"
import { Subscription } from "../../src/modules/credits/subscription.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { CreditTransaction } from "../../src/modules/credits/credit-transaction.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { planConfig } from "../../src/modules/billing/plan.config.js"
import { renewDueSubscriptions } from "../../src/modules/billing/subscription-renewal.service.js"

const DAY = 86_400_000
const NOW = new Date("2026-11-01T00:00:00.000Z")

const seedOrg = async (opts: { plan: "free" | "pro"; periodEnd: Date; balance: number; reserved?: number }) => {
  const userId = new mongoose.Types.ObjectId()
  const organizationId = new mongoose.Types.ObjectId()
  await CreditWallet.create({ userId, organizationId, balance: opts.balance, reserved: opts.reserved ?? 0 })
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

describe("UC-80 - Billing Scheduler", () => {
  it("Pro hết kỳ ⇒ về Free, cộng đủ +300 credit thành 340, thông báo plan_expired", async () => {
    const { userId, organizationId, subId } = await seedOrg({ plan: "pro", periodEnd: new Date(NOW.getTime() - DAY), balance: 40 })

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 0, downgraded: 1, creditsGranted: 300 })
    const sub = await Subscription.findById(subId).lean()
    expect(sub?.plan).toBe("free")
    expect(sub?.status).toBe("active")
    expect(sub?.monthlyCreditsAllotment).toBe(planConfig.free.monthlyCredits)
    expect(sub?.currentPeriodEnd.getTime()).toBeGreaterThan(NOW.getTime())
    expect((await walletOf(organizationId))?.balance).toBe(340)

    const txs = await CreditTransaction.find({ organizationId, type: "monthly_reset" }).lean()
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({ type: "monthly_reset", actionType: "monthly_reset", amount: 300, balanceAfter: 340 })

    const notes = await Notification.find({ userId }).lean()
    expect(notes.map((n) => n.type)).toEqual(["plan_expired"])
    expect(String(notes[0].organizationId)).toBe(String(organizationId))
    expect(notes[0].body).toContain("+300 credit")
  })

  it("Free hết kỳ ⇒ kỳ mới nối tiếp kỳ cũ, cộng đủ +300 thành 420, ghi giao dịch monthly_reset và thông báo credits_renewed", async () => {
    const periodEnd = new Date(NOW.getTime() - 2 * DAY)
    const { userId, organizationId, subId } = await seedOrg({ plan: "free", periodEnd, balance: 120, reserved: 20 })

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 1, downgraded: 0, creditsGranted: 300 })
    const sub = await Subscription.findById(subId).lean()
    expect(sub?.currentPeriodStart.getTime()).toBe(periodEnd.getTime())
    expect(sub?.currentPeriodEnd.getTime()).toBe(periodEnd.getTime() + planConfig.periodDays * DAY)

    const txs = await CreditTransaction.find({ organizationId }).lean()
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({
      type: "monthly_reset",
      actionType: "monthly_reset",
      amount: 300,
      balanceAfter: 400
    })
    expect((await walletOf(organizationId))?.balance).toBe(420)

    const notes = await Notification.find({ organizationId }).lean()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ type: "credits_renewed", userId })
    expect(notes[0].body).toContain("+300 credit")
  })

  it("Pro hết kỳ khi ví đang có 850 credit từ gói nạp + đổi Lead ⇒ về Free, cộng đủ +300 thành 1150, chỉ báo các Lead hiện tại", async () => {
    const { userId: exLeadId, organizationId, subId } = await seedOrg({
      plan: "pro",
      periodEnd: new Date(NOW.getTime() - DAY),
      balance: 850
    })
    const leadA = new mongoose.Types.ObjectId()
    const leadB = new mongoose.Types.ObjectId()
    await Membership.create([
      { organizationId, userId: exLeadId, role: "analyst" },
      { organizationId, userId: leadA, role: "lead" },
      { organizationId, userId: leadB, role: "lead" }
    ])

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 0, downgraded: 1, creditsGranted: 300 })
    expect((await Subscription.findById(subId).lean())?.plan).toBe("free")
    expect((await walletOf(organizationId))?.balance).toBe(1150)
    const [tx] = await CreditTransaction.find({ organizationId, type: "monthly_reset" }).lean()
    expect(tx).toMatchObject({ amount: 300, balanceAfter: 1150 })

    const notes = await Notification.find({ organizationId }).lean()
    expect(notes.map((n) => String(n.userId)).sort()).toEqual([String(leadA), String(leadB)].sort())
    expect(notes.every((n) => n.type === "plan_expired" && n.body.includes("+300 credit"))).toBe(true)
  })

  it("Free hết kỳ khi ví đang có 500 credit ⇒ cộng thêm +300 thành 800 và ghi giao dịch monthly_reset", async () => {
    const { organizationId } = await seedOrg({ plan: "free", periodEnd: new Date(NOW.getTime() - DAY), balance: 500 })
    const result = await renewDueSubscriptions(NOW)
    expect(result).toEqual({ renewed: 1, downgraded: 0, creditsGranted: 300 })
    expect((await walletOf(organizationId))?.balance).toBe(800)
    expect(await CreditTransaction.countDocuments({ organizationId, type: "monthly_reset", amount: 300 })).toBe(1)
    const notes = await Notification.find({ organizationId }).lean()
    expect(notes.map((n) => n.type)).toEqual(["credits_renewed"])
    expect(notes[0].body).toContain("+300 credit")
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
