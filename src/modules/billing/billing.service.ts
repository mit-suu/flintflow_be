import mongoose, { ClientSession } from "mongoose"
import { env } from "../../config/env.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { getOrCreateWallet } from "../../shared/ai/credit-reservation.service.js"
import { CreditWallet } from "../credits/credit-wallet.model.js"
import { CreditTransaction } from "../credits/credit-transaction.model.js"
import { Subscription } from "../credits/subscription.model.js"
import { notify } from "../notification/notification.service.js"
import { PaymentIntent, IPaymentIntent } from "./payment-intent.model.js"
import { planConfig, findPackage, getPlan, PlanId } from "./plan.config.js"
import {
  buildCallbackUrl,
  createPaymentOrder,
  getPaymentOrder,
  isPaymentServiceConfigured,
  PaymentServiceOrder
} from "./payment-service.client.js"

const sessionOptions = (session?: ClientSession) => (session ? { session } : {})

const isTransactionUnsupported = (err: any): boolean =>
  Boolean(
    err?.message?.includes("replica set member") ||
      err?.message?.includes("Transaction numbers") ||
      // withTransaction trên standalone báo lỗi retryable writes thay vì transaction
      err?.message?.includes("retryable writes") ||
      err?.code === 20
  )

/**
 * Chạy trong Mongo transaction nếu được; Mongo standalone (dev) không hỗ trợ
 * transaction thì chạy lại không session — cùng cách ai-action.service xử lý.
 * `fn` KHÔNG được có side effect ngoài DB (notify gọi sau khi xong).
 */
const withOptionalTransaction = async <T>(
  fn: (session?: ClientSession) => Promise<T>
): Promise<T> => {
  let session: ClientSession | undefined
  try {
    session = await mongoose.startSession()
    let result: T | undefined
    await session.withTransaction(async () => {
      result = await fn(session)
    })
    return result as T
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      return fn()
    }
    throw err
  } finally {
    if (session) await session.endSession()
  }
}

// ─── Số dư / gói ─────────────────────────────────────────────────────

export const getBalance = async (userId: string) => {
  const wallet = await getOrCreateWallet(userId)
  const [subscription, ledger] = await Promise.all([
    Subscription.findOne({ userId, status: "active" }),
    CreditTransaction.find({ userId }, null, { sort: { createdAt: -1 }, limit: 20 })
  ])

  const plan: PlanId = subscription?.plan ?? "free"

  return {
    balance: wallet.balance,
    reserved: wallet.reserved,
    available: wallet.balance - wallet.reserved,
    plan,
    planLabel: getPlan(plan).label,
    lowCreditThreshold: planConfig.lowCreditThreshold,
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          monthlyCreditsAllotment: subscription.monthlyCreditsAllotment,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd
        }
      : null,
    ledger
  }
}

export const listPackages = () => ({
  packages: planConfig.packages,
  plans: [planConfig.free, planConfig.pro]
})

export const listTransactions = async (userId: string, page = 1, limit = 20) => {
  const [items, total] = await Promise.all([
    CreditTransaction.find({ userId }, null, {
      sort: { createdAt: -1 },
      skip: (page - 1) * limit,
      limit
    }),
    CreditTransaction.countDocuments({ userId })
  ])

  return {
    items,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) }
  }
}

// ─── Checkout ────────────────────────────────────────────────────────

const toIntentDTO = (intent: IPaymentIntent) => ({
  intentId: intent._id.toString(),
  packageId: intent.packageId,
  credits: intent.credits,
  amount: intent.amount,
  currency: intent.currency,
  status: intent.status,
  referenceCode: intent.referenceCode ?? null,
  paymentDescription: intent.paymentDescription ?? null,
  qrCodeUrl: intent.qrCodeUrl ?? null,
  processedAt: intent.processedAt ?? null,
  createdAt: intent.createdAt
})

export type PaymentIntentDTO = ReturnType<typeof toIntentDTO>

export const createCheckout = async (userId: string, packageId: string): Promise<PaymentIntentDTO> => {
  const pkg = findPackage(packageId)
  if (!pkg) {
    throw new ApiError(404, "Không tìm thấy gói credit", "PACKAGE_NOT_FOUND")
  }
  if (!isPaymentServiceConfigured()) {
    throw new ApiError(503, "Cổng thanh toán chưa được cấu hình", "PAYMENT_SERVICE_NOT_CONFIGURED")
  }

  // Tạo intent local trước để có ID đối chiếu trong description của order
  const intent = await PaymentIntent.create({
    userId: new mongoose.Types.ObjectId(userId),
    packageId: pkg.id,
    credits: pkg.credits,
    amount: pkg.amount,
    currency: pkg.currency,
    provider: "payment_service",
    status: "pending"
  })
  const intentId = intent._id.toString()

  let order
  try {
    order = await createPaymentOrder({
      amount: pkg.amount,
      description: `FlintFlow ${pkg.id} intent ${intentId}`,
      callbackUrl: buildCallbackUrl()
    })
  } catch (error) {
    await PaymentIntent.findOneAndUpdate(
      { _id: intentId, status: "pending" },
      { $set: { status: "failed", processedAt: new Date() } }
    )
    throw error
  }

  const updated = await PaymentIntent.findOneAndUpdate(
    { _id: intentId },
    {
      $set: {
        paymentOrderId: order.order_id,
        referenceCode: order.reference_code,
        paymentDescription: order.payment_description,
        qrCodeUrl: order.qr_code_url
      }
    },
    { returnDocument: "after" }
  )

  return toIntentDTO(updated ?? intent)
}

// ─── Chốt kết quả thanh toán ─────────────────────────────────────────

export interface SettleResult {
  intent: IPaymentIntent
  settled: boolean
  creditsAdded: number
  balance?: number
}

/**
 * Chuyển intent pending → succeeded/failed (idempotent) và cộng credit khi
 * succeeded. Chỉ intent còn `pending` mới được chuyển, nên callback gọi lại
 * hoặc polling chạy song song với callback không cộng hai lần.
 */
const settleIntent = async (
  intentId: string,
  outcome: "succeeded" | "failed"
): Promise<SettleResult | null> => {
  const processed = await withOptionalTransaction(async (session) => {
    const options = sessionOptions(session)

    const intent = await PaymentIntent.findOneAndUpdate(
      { _id: intentId, status: "pending" },
      { $set: { status: outcome, processedAt: new Date() } },
      { ...options, returnDocument: "after" }
    )
    if (!intent) return null
    if (outcome === "failed") return { intent, balance: undefined }

    const userId = intent.userId.toString()
    await getOrCreateWallet(userId, session)
    const wallet = await CreditWallet.findOneAndUpdate(
      { userId },
      { $inc: { balance: intent.credits } },
      { ...options, returnDocument: "after" }
    )
    if (!wallet) {
      throw new ApiError(500, "Không tìm thấy ví credit", "WALLET_NOT_FOUND")
    }

    await CreditTransaction.create(
      [
        {
          userId: intent.userId,
          projectId: null,
          actionType: "purchase",
          amount: intent.credits,
          type: "purchase",
          balanceAfter: wallet.balance - wallet.reserved
        }
      ],
      options
    )

    return { intent, balance: wallet.balance }
  })

  if (!processed) return null

  const { intent, balance } = processed
  const userId = intent.userId.toString()

  if (outcome === "succeeded") {
    await notify(userId, {
      type: "payment_success",
      title: "Thanh toán thành công",
      body: `Đã cộng ${intent.credits} credit vào tài khoản của bạn.`,
      link: "/home/billing",
      meta: { intentId, credits: intent.credits, amount: intent.amount }
    })
  } else {
    await notify(userId, {
      type: "payment_failed",
      title: "Thanh toán thất bại",
      body: "Giao dịch nạp credit không thành công.",
      link: "/home/billing",
      meta: { intentId, amount: intent.amount }
    })
  }

  return {
    intent,
    settled: true,
    creditsAdded: outcome === "succeeded" ? intent.credits : 0,
    balance
  }
}

/**
 * Đối chiếu intent local với order trên payment_service — nguồn sự thật duy
 * nhất. Không cộng credit nếu số tiền hay client_id lệch.
 */
const reconcileWithRemote = async (
  intent: IPaymentIntent,
  remote: PaymentServiceOrder
): Promise<SettleResult | null> => {
  const intentId = intent._id.toString()

  if (remote.client_id && remote.client_id !== env.PAYMENT_CLIENT_ID) {
    console.error(`[Billing] Order ${remote.order_id} thuộc client khác (${remote.client_id})`)
    return null
  }

  if (remote.status === "paid") {
    if (Number(remote.amount) !== intent.amount) {
      console.error(
        `[Billing] Lệch số tiền order ${remote.order_id}: remote=${remote.amount}, intent=${intent.amount}`
      )
      return null
    }
    return settleIntent(intentId, "succeeded")
  }

  if (remote.status === "failed") {
    return settleIntent(intentId, "failed")
  }

  return null
}

/**
 * Trang QR polling endpoint này. Khi còn pending thì hỏi payment_service —
 * fallback cho trường hợp callback không tới được BE (vd. dev chạy localhost).
 */
export const getCheckout = async (userId: string, intentId: string): Promise<PaymentIntentDTO> => {
  if (!mongoose.isValidObjectId(intentId)) {
    throw new ApiError(400, "ID giao dịch không hợp lệ", "INVALID_INTENT_ID")
  }

  const intent = await PaymentIntent.findOne({ _id: intentId, userId })
  if (!intent) {
    throw new ApiError(404, "Không tìm thấy giao dịch", "INTENT_NOT_FOUND")
  }

  if (intent.status !== "pending" || !intent.paymentOrderId) {
    return toIntentDTO(intent)
  }

  try {
    const remote = await getPaymentOrder(intent.paymentOrderId)
    const result = await reconcileWithRemote(intent, remote)
    if (result) return toIntentDTO(result.intent)
  } catch (error) {
    // Cổng lỗi tạm thời: vẫn trả trạng thái local, lần poll sau thử lại
    console.warn(`[Billing] Poll order ${intent.paymentOrderId} failed:`, (error as Error).message)
  }

  const latest = await PaymentIntent.findOne({ _id: intentId })
  return toIntentDTO(latest ?? intent)
}

// ─── Callback từ payment_service ─────────────────────────────────────

export interface PaymentCallbackInput {
  order_id: string
  status: string
  client_id: string
}

export interface PaymentCallbackResult {
  success: true
  status: IPaymentIntent["status"]
  alreadyProcessed: boolean
  creditsAdded: number
}

/**
 * Callback hiện CHƯA được payment_service ký, nên body chỉ là "gợi ý":
 * trạng thái được xác minh lại bằng GET /api/orders/:order_id trước khi cộng credit.
 */
export const handlePaymentCallback = async (
  input: PaymentCallbackInput
): Promise<PaymentCallbackResult> => {
  if (input.client_id !== env.PAYMENT_CLIENT_ID) {
    throw new ApiError(403, "client_id không hợp lệ", "INVALID_CLIENT_ID")
  }

  const intent = await PaymentIntent.findOne({ paymentOrderId: input.order_id })
  if (!intent) {
    throw new ApiError(404, "Không tìm thấy giao dịch", "INTENT_NOT_FOUND")
  }

  if (intent.status !== "pending") {
    return { success: true, status: intent.status, alreadyProcessed: true, creditsAdded: 0 }
  }

  const remote = await getPaymentOrder(input.order_id)
  const result = await reconcileWithRemote(intent, remote)

  if (!result) {
    const latest = await PaymentIntent.findOne({ _id: intent._id })
    const status = latest?.status ?? intent.status
    return { success: true, status, alreadyProcessed: status !== "pending", creditsAdded: 0 }
  }

  return {
    success: true,
    status: result.intent.status,
    alreadyProcessed: false,
    creditsAdded: result.creditsAdded
  }
}

// ─── Nâng cấp gói ────────────────────────────────────────────────────

export const upgradePlan = async (userId: string, plan: PlanId) => {
  const current = await Subscription.findOne({ userId })
  if (current && current.plan === plan && current.status === "active") {
    return current
  }

  const definition = getPlan(plan)
  const now = new Date()
  const periodEnd = new Date(now.getTime() + planConfig.periodDays * 24 * 60 * 60 * 1000)

  const subscription = await Subscription.findOneAndUpdate(
    { userId },
    {
      $set: {
        plan,
        status: "active",
        monthlyCreditsAllotment: definition.monthlyCredits,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd
      },
      $setOnInsert: { userId: new mongoose.Types.ObjectId(userId) }
    },
    { upsert: true, returnDocument: "after" }
  )

  await notify(userId, {
    type: "plan_changed",
    title: `Đã chuyển sang gói ${definition.label}`,
    body: `Gói ${definition.label} có hiệu lực đến ${periodEnd.toLocaleDateString("vi-VN")}.`,
    link: "/home/billing",
    meta: { plan, previousPlan: current?.plan ?? null }
  })

  return subscription
}
