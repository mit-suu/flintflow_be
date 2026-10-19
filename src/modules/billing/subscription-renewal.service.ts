/**
 * UC-80 (FLF-309): sang kỳ mới cho gói đã hết `currentPeriodEnd`.
 *   - Gói trả phí (Pro) hết kỳ ⇒ về Free: chưa có gia hạn tự động, muốn giữ Pro thì mua lại qua checkout `plan:pro`.
 *   - Gói Free hết kỳ ⇒ mở kỳ mới.
 * Đầu kỳ mới nạp ví lên tới `monthlyCreditsAllotment` của gói (`monthly_reset`). Ví đang nhiều hơn thì giữ nguyên —
 * "reset" là nạp lại hạn mức, không cộng dồn mỗi tháng và không xoá credit đã mua.
 *
 * Chạy lại an toàn: đổi kỳ là `findOneAndUpdate` khớp đúng `currentPeriodEnd` cũ, nên hai lượt chạy song song (hai
 * instance API ở driver inline) chỉ một lượt thắng và cộng credit. Đổi kỳ + nạp ví nằm trong cùng transaction.
 */

import type { ClientSession } from "mongoose"
import { getOrCreateWallet } from "../../shared/ai/credit-reservation.service.js"
import { CreditWallet } from "../credits/credit-wallet.model.js"
import { CreditTransaction } from "../credits/credit-transaction.model.js"
import { ISubscription, Subscription } from "../credits/subscription.model.js"
import { notify } from "../notification/notification.service.js"
import { sessionOptions, withOptionalTransaction } from "./billing.service.js"
import { getPlan, planConfig, PlanId } from "./plan.config.js"

/** Số gói xử lý tối đa mỗi lượt; còn thừa thì lượt sau (job chạy mỗi giờ) làm tiếp. */
const BATCH_SIZE = 200

const DAY_MS = 24 * 60 * 60 * 1000

export interface RenewalResult {
  renewed: number
  downgraded: number
  creditsGranted: number
}

interface RenewedPeriod {
  subscription: ISubscription
  previousPlan: PlanId
  plan: PlanId
  granted: number
}

/**
 * Kỳ mới tính tiếp từ cuối kỳ cũ để không trôi ngày chạy job; job dừng lâu (quá một kỳ) thì bắt đầu lại từ `now`.
 */
export const nextPeriodStart = (previousEnd: Date, now: Date): Date =>
  now.getTime() - previousEnd.getTime() < planConfig.periodDays * DAY_MS ? previousEnd : now

/** Nạp ví tới hạn mức của gói; trả số credit đã cộng (0 nếu ví đã đủ). */
const topUpToAllotment = async (sub: ISubscription, allotment: number, session?: ClientSession): Promise<number> => {
  const options = sessionOptions(session)
  const userId = String(sub.userId)
  const orgId = sub.organizationId ? String(sub.organizationId) : null
  const wallet = await getOrCreateWallet(userId, session, orgId)
  const granted = Math.max(0, allotment - wallet.balance)
  if (granted === 0) return 0

  const updated = await CreditWallet.findOneAndUpdate(
    { _id: wallet._id },
    { $inc: { balance: granted } },
    { ...options, returnDocument: "after" }
  )
  if (!updated) return 0

  await CreditTransaction.create(
    [
      {
        userId: sub.userId,
        organizationId: sub.organizationId,
        projectId: null,
        actionType: "monthly_reset",
        amount: granted,
        type: "monthly_reset",
        balanceAfter: updated.balance - updated.reserved
      }
    ],
    options
  )
  return granted
}

const renewOne = async (sub: ISubscription, now: Date): Promise<RenewedPeriod | null> =>
  withOptionalTransaction(async (session) => {
    const previousPlan = sub.plan as PlanId
    // Gói trả phí không tự gia hạn ⇒ về Free.
    const plan: PlanId = getPlan(previousPlan).priceVnd > 0 ? "free" : previousPlan
    const definition = getPlan(plan)
    const start = nextPeriodStart(sub.currentPeriodEnd, now)

    const claimed = await Subscription.findOneAndUpdate(
      { _id: sub._id, status: "active", currentPeriodEnd: sub.currentPeriodEnd },
      {
        $set: {
          plan,
          monthlyCreditsAllotment: definition.monthlyCredits,
          currentPeriodStart: start,
          currentPeriodEnd: new Date(start.getTime() + planConfig.periodDays * DAY_MS)
        }
      },
      { ...sessionOptions(session), returnDocument: "after" }
    )
    // Lượt khác đã sang kỳ cho gói này.
    if (!claimed) return null

    const granted = await topUpToAllotment(claimed, definition.monthlyCredits, session)
    return { subscription: claimed, previousPlan, plan, granted }
  })

const notifyRenewal = async ({ subscription, previousPlan, plan, granted }: RenewedPeriod): Promise<void> => {
  const userId = String(subscription.userId)
  const organizationId = subscription.organizationId ? String(subscription.organizationId) : undefined
  const periodEnd = subscription.currentPeriodEnd

  if (plan !== previousPlan) {
    await notify(userId, {
      organizationId,
      type: "plan_expired",
      title: `Gói ${getPlan(previousPlan).label} đã hết hạn`,
      body: `Tổ chức đã chuyển về gói ${getPlan(plan).label}. Mua lại gói ${getPlan(previousPlan).label} để tiếp tục dùng giới hạn cao hơn.`,
      link: "/home/billing",
      meta: { plan, previousPlan, periodEnd, credits: granted }
    })
    return
  }

  if (granted > 0) {
    await notify(userId, {
      organizationId,
      type: "monthly_credits",
      title: "Đã cấp credit kỳ mới",
      body: `Đã nạp ${granted} credit vào ví tổ chức cho kỳ đến ${periodEnd.toLocaleDateString("vi-VN")}.`,
      link: "/home/billing",
      meta: { plan, periodEnd, credits: granted }
    })
  }
}

/** Quét gói `active` đã quá `currentPeriodEnd` và sang kỳ mới cho từng gói. */
export const renewDueSubscriptions = async (now: Date = new Date()): Promise<RenewalResult> => {
  const due = await Subscription.find({ status: "active", currentPeriodEnd: { $lte: now } }, null, {
    sort: { currentPeriodEnd: 1 },
    limit: BATCH_SIZE
  })

  const result: RenewalResult = { renewed: 0, downgraded: 0, creditsGranted: 0 }
  for (const sub of due) {
    try {
      const renewed = await renewOne(sub, now)
      if (!renewed) continue
      if (renewed.plan !== renewed.previousPlan) result.downgraded += 1
      else result.renewed += 1
      result.creditsGranted += renewed.granted
      await notifyRenewal(renewed)
    } catch (err) {
      // Một gói lỗi không chặn các gói còn lại; lượt sau thử lại vì gói vẫn quá hạn.
      console.error(`[Billing] Sang kỳ mới cho subscription ${String(sub._id)} lỗi:`, err)
    }
  }
  return result
}
