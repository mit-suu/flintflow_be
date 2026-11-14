/**
 * UC-80 (FLF-309 / FLF-417): sang kỳ mới cho gói đã hết `currentPeriodEnd`.
 *   - Gói trả phí (Pro) hết kỳ ⇒ về Free: chưa có gia hạn tự động, muốn giữ Pro thì mua lại qua checkout `plan:pro`.
 *   - Gói Free hết kỳ ⇒ mở kỳ mới.
 * Đầu kỳ mới cộng dồn đủ `monthlyCredits` của gói hiện tại (`monthly_reset`, BR-01) bất kể số dư hiện có
 * để không xoá hoặc triệt tiêu credit đã mua trước đó, và gửi thông báo tới toàn bộ Lead hiện tại của tổ chức.
 *
 * Chạy lại an toàn: đổi kỳ là `findOneAndUpdate` khớp đúng `currentPeriodEnd` cũ, nên hai lượt chạy song song (hai
 * instance API ở driver inline) chỉ một lượt thắng và cộng credit. Đổi kỳ + nạp ví nằm trong cùng transaction.
 */

import mongoose, { type ClientSession } from "mongoose"
import { getOrCreateWallet } from "../../shared/ai/credit-reservation.service.js"
import { CreditWallet } from "../credits/credit-wallet.model.js"
import { CreditTransaction } from "../credits/credit-transaction.model.js"
import { ISubscription, Subscription } from "../credits/subscription.model.js"
import { Membership } from "../organization/membership.model.js"
import { notify, type NotificationPayload } from "../notification/notification.service.js"
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

export type RenewalRunResult = RenewalResult

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

/** Cộng đủ hạn mức của kỳ mới vào ví org và ghi giao dịch `monthly_reset`. */
const grantCycleCredits = async (
  organizationId: mongoose.Types.ObjectId,
  fallbackUserId: mongoose.Types.ObjectId,
  allotment: number,
  session?: ClientSession
): Promise<number> => {
  if (allotment <= 0) return 0
  const options = sessionOptions(session)
  const wallet = await getOrCreateWallet(String(fallbackUserId), session, String(organizationId))

  const updated = await CreditWallet.findOneAndUpdate(
    { _id: wallet._id },
    { $inc: { balance: allotment } },
    { ...options, returnDocument: "after" }
  )
  if (!updated) return 0

  await CreditTransaction.create(
    [
      {
        userId: fallbackUserId,
        organizationId,
        projectId: null,
        actionType: "monthly_reset",
        amount: allotment,
        type: "monthly_reset",
        balanceAfter: updated.balance - updated.reserved
      }
    ],
    options
  )
  return allotment
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

    // FLF-310: credit chỉ nằm ở ví tổ chức — subscription cũ không gắn org thì không có ví để nạp
    const granted = claimed.organizationId
      ? await grantCycleCredits(claimed.organizationId, claimed.userId, definition.monthlyCredits, session)
      : 0
    return { subscription: claimed, previousPlan, plan, granted }
  })

const resolveRenewalRecipients = async (subscription: ISubscription): Promise<string[]> => {
  if (!subscription.organizationId) return [String(subscription.userId)]
  const leads = await Membership.find({ organizationId: subscription.organizationId, role: "lead" })
    .select("userId")
    .lean()
  const leadIds = [...new Set(leads.map((m) => m.userId).filter(Boolean).map(String))]
  return leadIds.length > 0 ? leadIds : [String(subscription.userId)]
}

const notifyRenewal = async ({ subscription, previousPlan, plan, granted }: RenewedPeriod): Promise<void> => {
  const downgraded = plan !== previousPlan
  if (!downgraded && granted <= 0) return

  const organizationId = subscription.organizationId ? String(subscription.organizationId) : undefined
  const periodEnd = subscription.currentPeriodEnd
  const recipients = await resolveRenewalRecipients(subscription)

  const payload: NotificationPayload = downgraded
    ? {
        organizationId,
        type: "plan_expired",
        title: `Gói ${getPlan(previousPlan).label} đã hết hạn`,
        body:
          granted > 0
            ? `Tổ chức đã chuyển về gói ${getPlan(plan).label} và được cộng +${granted} credit cho kỳ mới đến ${periodEnd.toLocaleDateString("vi-VN")}. Mua lại gói ${getPlan(previousPlan).label} để tiếp tục dùng giới hạn cao hơn.`
            : `Tổ chức đã chuyển về gói ${getPlan(plan).label}. Mua lại gói ${getPlan(previousPlan).label} để tiếp tục dùng giới hạn cao hơn.`,
        link: "/home/billing",
        meta: { plan, previousPlan, periodEnd, credits: granted }
      }
    : {
        organizationId,
        type: "credits_renewed",
        title: "Đã cấp credit kỳ mới",
        body: `Ví tổ chức đã được cộng +${granted} credit cho kỳ mới đến ${periodEnd.toLocaleDateString("vi-VN")}.`,
        link: "/home/billing",
        meta: { plan, periodEnd, credits: granted }
      }

  await Promise.all(recipients.map((userId) => notify(userId, payload)))
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
      try {
        await notifyRenewal(renewed)
      } catch (notifyErr) {
        console.warn(`[Billing] Không gửi được thông báo gia hạn cho subscription ${String(sub._id)}:`, notifyErr)
      }
    } catch (err) {
      // Một gói lỗi không chặn các gói còn lại; lượt sau thử lại vì gói vẫn quá hạn.
      console.error(`[Billing] Sang kỳ mới cho subscription ${String(sub._id)} lỗi:`, err)
    }
  }
  return result
}
