import { describe, it, expect, beforeEach, vi } from "vitest"
import mongoose from "mongoose"

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
vi.mock("../organization/membership.model.js", async () => {
  const { fakeDb } = await import("./__tests__/fake-mongo.js")
  const model = fakeDb.model("Membership")
  return {
    Membership: {
      ...model,
      find: (filter: Record<string, unknown>, projection?: unknown, options?: Record<string, unknown>) => {
        const promise = model.find(filter, projection, options)
        return {
          select: () => ({
            lean: () => promise
          }),
          lean: () => promise,
          then: promise.then.bind(promise),
          catch: promise.catch.bind(promise)
        }
      }
    }
  }
})
vi.mock("../notification/notification.service.js", () => ({
  notify: vi.fn(async () => null),
  notifyAdmins: vi.fn(async () => 0)
}))

import { fakeDb, TRANSACTION_UNSUPPORTED } from "./__tests__/fake-mongo.js"
import { notify } from "../notification/notification.service.js"
import { findJobDef } from "../../shared/queue/job-runner.js"
import { planConfig } from "./plan.config.js"
import { nextPeriodStart, renewDueSubscriptions } from "./subscription-renewal.service.js"
import "./subscription-renewal.jobs.js"

const DAY = 86_400_000
const NOW = new Date("2026-11-01T00:00:00.000Z")

const oid = () => new mongoose.Types.ObjectId()

const seedSubAndWallet = async (opts: { plan: "free" | "pro"; periodEnd: Date; balance: number; reserved?: number }) => {
  const userId = oid()
  const organizationId = oid()
  await fakeDb.model("CreditWallet").create({
    userId,
    organizationId,
    balance: opts.balance,
    reserved: opts.reserved ?? 0
  })
  const sub = await fakeDb.model("Subscription").create({
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

const walletOf = (organizationId: mongoose.Types.ObjectId) =>
  fakeDb.model("CreditWallet").docs.find((w) => String(w.organizationId) === String(organizationId))

const monthlyResetTxs = (organizationId: mongoose.Types.ObjectId) =>
  fakeDb.model("CreditTransaction").docs.filter(
    (t) => String(t.organizationId) === String(organizationId) && t.type === "monthly_reset"
  )

describe("nextPeriodStart", () => {
  it("kỳ mới nối tiếp cuối kỳ cũ khi job chạy trễ ít hơn một kỳ", () => {
    const end = new Date("2026-10-01T00:00:00.000Z")
    const now = new Date(end.getTime() + 3 * DAY)
    expect(nextPeriodStart(end, now)).toBe(end)
  })

  it("job dừng quá một kỳ ⇒ bắt đầu lại từ now", () => {
    const end = new Date("2026-10-01T00:00:00.000Z")
    const now = new Date(end.getTime() + (planConfig.periodDays + 1) * DAY)
    expect(nextPeriodStart(end, now)).toBe(now)
  })
})

describe("renew-subscriptions job", () => {
  it("đăng ký job định kỳ mỗi giờ ở queue system", () => {
    const def = findJobDef("system", "renew-subscriptions")
    expect(def?.repeatEveryMs).toBe(60 * 60_000)
  })
})

describe("renewDueSubscriptions", () => {
  beforeEach(() => {
    fakeDb.reset()
    vi.clearAllMocks()
    vi.spyOn(mongoose, "startSession").mockRejectedValue(TRANSACTION_UNSUPPORTED)
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("Pro hết kỳ khi ví đang có 40 credit ⇒ về Free, cộng dồn +300 thành 340 và fallback notify subscription.userId", async () => {
    const { userId, organizationId } = await seedSubAndWallet({
      plan: "pro",
      periodEnd: new Date(NOW.getTime() - DAY),
      balance: 40
    })

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 0, downgraded: 1, creditsGranted: 300 })
    expect(walletOf(organizationId)?.balance).toBe(340)
    const txs = monthlyResetTxs(organizationId)
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({ actionType: "monthly_reset", type: "monthly_reset", amount: 300, balanceAfter: 340 })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      String(userId),
      expect.objectContaining({
        organizationId: String(organizationId),
        type: "plan_expired",
        body: expect.stringContaining("+300 credit")
      })
    )
  })

  it("Free hết kỳ khi ví đang có 120 credit (reserved 20) ⇒ cộng dồn +300 thành 420, balanceAfter trừ reserved", async () => {
    const { userId, organizationId } = await seedSubAndWallet({
      plan: "free",
      periodEnd: new Date(NOW.getTime() - DAY),
      balance: 120,
      reserved: 20
    })

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 1, downgraded: 0, creditsGranted: 300 })
    expect(walletOf(organizationId)?.balance).toBe(420)
    const txs = monthlyResetTxs(organizationId)
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({ type: "monthly_reset", actionType: "monthly_reset", amount: 300, balanceAfter: 400 })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      String(userId),
      expect.objectContaining({
        organizationId: String(organizationId),
        type: "credits_renewed",
        body: expect.stringContaining("+300 credit")
      })
    )
  })

  it("Free hết kỳ khi ví đang có 500 credit ⇒ vẫn cộng đủ +300 thành 800 và thông báo mọi Lead hiện tại", async () => {
    const { userId: analystId, organizationId } = await seedSubAndWallet({
      plan: "free",
      periodEnd: new Date(NOW.getTime() - DAY),
      balance: 500
    })
    const leadA = oid()
    const leadB = oid()
    await fakeDb.model("Membership").create([
      { organizationId, userId: analystId, role: "analyst" },
      { organizationId, userId: leadA, role: "lead" },
      { organizationId, userId: leadB, role: "lead" }
    ])

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 1, downgraded: 0, creditsGranted: 300 })
    expect(walletOf(organizationId)?.balance).toBe(800)
    expect(monthlyResetTxs(organizationId)).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(2)
    const notifiedUsers = vi.mocked(notify).mock.calls.map(([uid]) => uid).sort()
    expect(notifiedUsers).toEqual([String(leadA), String(leadB)].sort())
    for (const [, payload] of vi.mocked(notify).mock.calls) {
      expect(payload).toMatchObject({
        organizationId: String(organizationId),
        type: "credits_renewed"
      })
      expect(payload.body).toContain("+300 credit")
    }
  })

  it("Pro hết kỳ khi ví đang có 850 credit + đổi Lead + trùng userId ⇒ cộng đủ +300 thành 1150, khử trùng và chỉ báo các Lead hiện tại", async () => {
    const { userId: exLeadId, organizationId } = await seedSubAndWallet({
      plan: "pro",
      periodEnd: new Date(NOW.getTime() - DAY),
      balance: 850
    })
    const leadA = oid()
    const leadB = oid()
    await fakeDb.model("Membership").create([
      { organizationId, userId: exLeadId, role: "analyst" },
      { organizationId, userId: leadA, role: "lead" },
      { organizationId, userId: leadA, role: "lead" },
      { organizationId, userId: leadB, role: "lead" }
    ])

    const result = await renewDueSubscriptions(NOW)

    expect(result).toEqual({ renewed: 0, downgraded: 1, creditsGranted: 300 })
    expect(walletOf(organizationId)?.balance).toBe(1150)
    expect(monthlyResetTxs(organizationId)).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(2)
    const notifiedUsers = vi.mocked(notify).mock.calls.map(([uid]) => uid).sort()
    expect(notifiedUsers).toEqual([String(leadA), String(leadB)].sort())
    for (const [, payload] of vi.mocked(notify).mock.calls) {
      expect(payload).toMatchObject({
        organizationId: String(organizationId),
        type: "plan_expired"
      })
      expect(payload.body).toContain("+300 credit")
    }
  })
})
