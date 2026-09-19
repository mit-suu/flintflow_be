import mongoose, { ClientSession } from "mongoose"
import { CreditWallet } from "../../modules/credits/credit-wallet.model.js"
import { CreditTransaction } from "../../modules/credits/credit-transaction.model.js"
import { PricingConfig } from "../../modules/admin/pricing-config.model.js"
import { planConfig } from "../../modules/billing/plan.config.js"
import { notify, notifyAdmins } from "../../modules/notification/notification.service.js"
import { env } from "../../config/env.js"
import { ActionType, AiActionError } from "./ai-action.types.js"

const DEFAULT_ACTION_COSTS: Record<string, number> = {
  // Giá theo lượt gọi model (Phases §4.2), T03
  [ActionType.ELICIT]: 1,
  [ActionType.DRAFT]: 4,
  [ActionType.REVIEW]: 2,
  [ActionType.REGENERATE]: 4,
  [ActionType.REVISION]: 3,
  [ActionType.RENDER_FIX]: 1,
  [ActionType.DISCOVERY_STEP]: 2,
  [ActionType.CONSISTENCY_PASS]: 3,
  [ActionType.GLOSSARY_SCAN]: 2,
  [ActionType.RECONCILE]: 4,
  [ActionType.CHANGE_INSTRUCTION]: 3,
  // Ngoài pipeline
  [ActionType.CHAT]: 2,
  [ActionType.SUMMARIZE_DOCUMENT]: 2  // Task 2b: tính phí như EXTRACT, 1 lần/document
}

/** Một lần giữ credit. Truyền nguyên object này cho deduct/release. */
export interface CreditReservation {
  reservationId: string
  userId: string
  actionType: string
  cost: number
  projectId?: string
  expiresAt: Date
}

export interface ExpireStaleReservationsResult {
  expiredCount: number
  releasedCredits: number
}

const sessionOptions = (session?: ClientSession) => (session ? { session } : {})

const toObjectIdOrNull = (id?: string) => (id ? new mongoose.Types.ObjectId(id) : null)

const ledgerInconsistent = (message: string, details: Record<string, unknown>) =>
  new AiActionError(500, message, "CREDIT_LEDGER_INCONSISTENT", details)

export const getActionCost = async (actionType: string): Promise<number> => {
  try {
    const activePricing = await PricingConfig.findOne({ isActive: true })
    if (activePricing?.actionCosts && typeof activePricing.actionCosts[actionType] === "number") {
      return activePricing.actionCosts[actionType]
    }
  } catch (error) {
    console.warn(`[CreditReservation] Failed to query PricingConfig, using default cost for '${actionType}'`)
  }

  return DEFAULT_ACTION_COSTS[actionType] ?? 2
}

export const getOrCreateWallet = async (
  userId: string,
  session?: ClientSession
) => {
  const options = sessionOptions(session)
  const wallet = await CreditWallet.findOne({ userId }, null, options)
  if (wallet) return wallet

  const initialCredits = planConfig.free.initialCredits
  try {
    const created = await CreditWallet.create(
      [
        {
          userId: new mongoose.Types.ObjectId(userId),
          balance: initialCredits,
          reserved: 0
        }
      ],
      options
    )

    // Ví được tạo lần đầu = tài khoản bắt đầu dùng dịch vụ.
    // Không await: notification không được chặn request.
    void notify(userId, {
      type: "welcome",
      title: "Chào mừng bạn đến với FlintFlow",
      body: `Tài khoản của bạn đã sẵn sàng với ${initialCredits} credit miễn phí.`,
      link: "/home/billing",
      // FE dựng lại câu theo ngôn ngữ của user từ tham số này (T25)
      meta: { credits: initialCredits }
    })
    void notifyAdmins({
      type: "admin_new_user",
      title: "Người dùng mới",
      body: `Một người dùng mới vừa bắt đầu sử dụng FlintFlow (${userId}).`,
      meta: { userId }
    })

    return created[0]
  } catch (error: any) {
    // Hai request song song cùng tạo ví: unique index userId chặn bản thứ hai
    if (error?.code === 11000) {
      const existing = await CreditWallet.findOne({ userId }, null, options)
      if (existing) return existing
    }
    throw error
  }
}

export const reserveCredit = async (
  userId: string,
  actionType: string,
  projectId?: string,
  session?: ClientSession
): Promise<CreditReservation> => {
  const cost = await getActionCost(actionType)
  const options = sessionOptions(session)
  await getOrCreateWallet(userId, session)

  // Kiểm tra khả dụng và giữ credit trong MỘT lệnh atomic — tránh hai request
  // song song cùng đọc thấy đủ credit rồi cùng reserve.
  const wallet = await CreditWallet.findOneAndUpdate(
    {
      userId,
      $expr: { $gte: [{ $subtract: ["$balance", "$reserved"] }, cost] }
    },
    { $inc: { reserved: cost } },
    { ...options, returnDocument: "after" }
  )

  if (!wallet) {
    const current = await CreditWallet.findOne({ userId }, null, options)
    const balance = current?.balance ?? 0
    const reserved = current?.reserved ?? 0
    const available = balance - reserved
    throw new AiActionError(
      402,
      `Không đủ credit. Yêu cầu: ${cost} credit, Khả dụng: ${available} credit.`,
      "INSUFFICIENT_CREDIT",
      { cost, available, balance, reserved }
    )
  }

  const expiresAt = new Date(Date.now() + env.CREDIT_RESERVE_TTL_MS)

  const [reservation] = await CreditTransaction.create(
    [
      {
        userId: new mongoose.Types.ObjectId(userId),
        projectId: toObjectIdOrNull(projectId),
        actionType,
        amount: cost,
        type: "reserve",
        state: "reserved",
        expires_at: expiresAt,
        balanceAfter: wallet.balance - wallet.reserved
      }
    ],
    options
  )

  return {
    reservationId: reservation._id.toString(),
    userId,
    actionType,
    cost,
    projectId,
    expiresAt
  }
}

const maybeNotifyLowCredit = (userId: string, balanceBefore: number, balanceAfter: number) => {
  const threshold = planConfig.lowCreditThreshold
  // Chỉ báo khi VỪA vượt ngưỡng, không báo lại mỗi lần trừ tiếp
  if (balanceBefore >= threshold && balanceAfter < threshold) {
    void notify(userId, {
      type: "low_credit",
      title: "Credit sắp hết",
      body: `Số dư của bạn còn ${balanceAfter} credit. Nạp thêm để tiếp tục sử dụng AI.`,
      link: "/home/billing",
      meta: { balance: balanceAfter, threshold }
    })
  }
}

/**
 * Trừ credit cho một reservation sau khi AI chạy VÀ parse thành công.
 * Idempotent: gọi lại trên reservation đã deducted là no-op.
 */
export const deductCredit = async (
  reservation: CreditReservation,
  session?: ClientSession
): Promise<void> => {
  const { reservationId, userId, actionType, cost, projectId } = reservation
  const options = sessionOptions(session)

  // Claim reservation trước (chặn trừ hai lần). Cron có thể đã expire trước khi AI kịp
  // trả lời: vẫn tính phí, claim expired → deducted.
  let previousState: "reserved" | "expired" = "reserved"
  let claimed = await CreditTransaction.findOneAndUpdate(
    { _id: reservationId, type: "reserve", state: "reserved" },
    { $set: { state: "deducted" } },
    { ...options, returnDocument: "after" }
  )
  if (!claimed) {
    previousState = "expired"
    claimed = await CreditTransaction.findOneAndUpdate(
      { _id: reservationId, type: "reserve", state: "expired" },
      { $set: { state: "deducted" } },
      { ...options, returnDocument: "after" }
    )
  }

  if (!claimed) {
    const current = await CreditTransaction.findOne({ _id: reservationId }, null, options)
    if (current?.state === "deducted") return
    throw ledgerInconsistent("Không thể trừ credit cho reservation không hợp lệ", {
      reservationId,
      state: current?.state ?? null
    })
  }

  // reserved: trừ cả balance lẫn phần đang giữ.
  // expired: phần giữ đã trả về ví ⇒ chỉ trừ trên số KHẢ DỤNG (balance - reserved),
  // không được đẩy khả dụng xuống âm khi reservation khác đang giữ credit.
  const walletFilter =
    previousState === "reserved"
      ? { userId, balance: { $gte: cost }, reserved: { $gte: cost } }
      : { userId, $expr: { $gte: [{ $subtract: ["$balance", "$reserved"] }, cost] } }
  const walletUpdate =
    previousState === "reserved" ? { $inc: { balance: -cost, reserved: -cost } } : { $inc: { balance: -cost } }

  const wallet = await CreditWallet.findOneAndUpdate(walletFilter, walletUpdate, {
    ...options,
    returnDocument: "after"
  })

  if (!wallet) {
    // Hoàn claim để release/cron còn xử lý reservation — không để `reserved` treo vĩnh viễn
    await CreditTransaction.findOneAndUpdate(
      { _id: reservationId, type: "reserve", state: "deducted" },
      { $set: { state: previousState } },
      options
    )
    throw ledgerInconsistent("Ví credit không khớp với reservation khi trừ credit", {
      reservationId,
      cost,
      previousState
    })
  }

  await CreditTransaction.create(
    [
      {
        userId: new mongoose.Types.ObjectId(userId),
        projectId: toObjectIdOrNull(projectId),
        actionType,
        amount: cost,
        type: "deduct",
        reservationId: new mongoose.Types.ObjectId(reservationId),
        // Cùng quy ước "khả dụng sau" với reserve/release/purchase
        balanceAfter: wallet.balance - wallet.reserved
      }
    ],
    options
  )

  maybeNotifyLowCredit(userId, wallet.balance + cost, wallet.balance)
}

/**
 * Trả credit đang giữ về ví khi action thất bại.
 * Trả về false nếu reservation không còn ở trạng thái `reserved`
 * (đã deducted / đã expired) — khi đó KHÔNG đụng vào ví.
 */
export const releaseCredit = async (
  reservation: CreditReservation,
  session?: ClientSession
): Promise<boolean> => {
  const { reservationId, userId, actionType, cost, projectId } = reservation
  const options = sessionOptions(session)

  const claimed = await CreditTransaction.findOneAndUpdate(
    { _id: reservationId, type: "reserve", state: "reserved" },
    { $set: { state: "refunded" } },
    { ...options, returnDocument: "after" }
  )
  if (!claimed) return false

  const wallet = await CreditWallet.findOneAndUpdate(
    { userId, reserved: { $gte: cost } },
    { $inc: { reserved: -cost } },
    { ...options, returnDocument: "after" }
  )

  if (!wallet) {
    throw ledgerInconsistent("Ví credit không khớp với reservation khi hoàn credit", {
      reservationId,
      cost
    })
  }

  await CreditTransaction.create(
    [
      {
        userId: new mongoose.Types.ObjectId(userId),
        projectId: toObjectIdOrNull(projectId),
        actionType,
        amount: cost,
        type: "release",
        reservationId: new mongoose.Types.ObjectId(reservationId),
        balanceAfter: wallet.balance - wallet.reserved
      }
    ],
    options
  )

  return true
}

export interface DeductedRefund {
  userId: string
  actionType: string
  amount: number
  projectId?: string
}

/**
 * Hoàn một khoản ĐÃ deduct về ví (XREQ T13→T04): model đã trả lời và bị trừ credit nhưng kết quả không
 * dùng được vì lỗi phía hệ thống — vd `409 SPINE_VERSION_CONFLICT` khi ghi Spine (hai tab).
 * Không idempotent: bên gọi phải tự chặn hoàn hai lần (meter claim dòng `usage` `deducted → refunded` trước).
 */
export const refundDeductedCredit = async (refund: DeductedRefund, session?: ClientSession): Promise<void> => {
  const { userId, actionType, amount, projectId } = refund
  if (amount <= 0) return
  const options = sessionOptions(session)

  const wallet = await CreditWallet.findOneAndUpdate(
    { userId },
    { $inc: { balance: amount } },
    { ...options, returnDocument: "after" }
  )
  if (!wallet) throw ledgerInconsistent("Không tìm thấy ví credit khi hoàn khoản đã trừ", { userId, amount })

  await CreditTransaction.create(
    [
      {
        userId: new mongoose.Types.ObjectId(userId),
        projectId: toObjectIdOrNull(projectId),
        actionType,
        amount,
        type: "refund",
        balanceAfter: wallet.balance - wallet.reserved
      }
    ],
    options
  )
}

/**
 * Dọn reservation treo quá `expires_at` (process chết giữa chừng, client ngắt
 * stream…). Gọi định kỳ từ server.ts.
 */
export const expireStaleReservations = async (
  now: Date = new Date(),
  batchSize = 500
): Promise<ExpireStaleReservationsResult> => {
  const stale = await CreditTransaction.find(
    { type: "reserve", state: "reserved", expires_at: { $lte: now } },
    null,
    { limit: batchSize, sort: { expires_at: 1 } }
  )

  const result: ExpireStaleReservationsResult = { expiredCount: 0, releasedCredits: 0 }

  for (const reservation of stale) {
    // Claim có điều kiện: deduct/release có thể vừa chạy xong giữa find và đây
    const claimed = await CreditTransaction.findOneAndUpdate(
      { _id: reservation._id, state: "reserved" },
      { $set: { state: "expired" } },
      { returnDocument: "after" }
    )
    if (!claimed) continue

    const wallet = await CreditWallet.findOneAndUpdate(
      { userId: reservation.userId, reserved: { $gte: reservation.amount } },
      { $inc: { reserved: -reservation.amount } },
      { returnDocument: "after" }
    )

    if (!wallet) {
      console.error(
        `[CreditReservation] Wallet reserved < reservation amount khi expire ${reservation._id} (user ${reservation.userId})`
      )
      continue
    }

    await CreditTransaction.create({
      userId: reservation.userId,
      projectId: reservation.projectId ?? null,
      actionType: reservation.actionType,
      amount: reservation.amount,
      type: "release",
      reservationId: reservation._id,
      balanceAfter: wallet.balance - wallet.reserved
    })

    result.expiredCount += 1
    result.releasedCredits += reservation.amount
  }

  return result
}
