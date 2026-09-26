import mongoose, { ClientSession } from "mongoose"
import { env } from "../../config/env.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { getOrCreateWallet } from "../../shared/ai/credit-reservation.service.js"
import { CreditWallet } from "../credits/credit-wallet.model.js"
import { CreditTransaction } from "../credits/credit-transaction.model.js"
import { Subscription } from "../credits/subscription.model.js"
import { notify } from "../notification/notification.service.js"
import { PaymentIntent, IPaymentIntent } from "./payment-intent.model.js"
import { planConfig, findPackage, getPlan, planFromPackageId, planPackageId, PlanId } from "./plan.config.js"
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

/**
 * Số dư của TỔ CHỨC (business-flow.md §2: "một ví chung cho mỗi org"). Phải cùng ví mà lượt gọi AI trừ
 * (`credit-reservation.resolveWalletOrg`), nếu không màn hình báo một đằng còn tiền đi một nẻo.
 */
export const getBalance = async (orgId: string, userId: string) => {
  const wallet = await getOrCreateWallet(userId, undefined, orgId)
  const [subscription, ledger] = await Promise.all([
    Subscription.findOne({ organizationId: orgId, status: "active" }),
    CreditTransaction.find({ organizationId: orgId }, null, { sort: { createdAt: -1 }, limit: 20 })
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

/** UC-79: lịch sử tiêu credit của CẢ org — mỗi dòng giữ `userId` để biết thành viên nào tiêu. */
export const listTransactions = async (orgId: string, page = 1, limit = 20) => {
  const [items, total] = await Promise.all([
    CreditTransaction.find({ organizationId: orgId }, null, {
      sort: { createdAt: -1 },
      skip: (page - 1) * limit,
      limit
    }),
    CreditTransaction.countDocuments({ organizationId: orgId })
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

export const createCheckout = async (orgId: string, userId: string, packageId: string): Promise<PaymentIntentDTO> => {
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
    organizationId: new mongoose.Types.ObjectId(orgId),
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
    if (outcome === "failed") return { intent, balance: undefined, planChange: null }

    const userId = intent.userId.toString()
    // Callback không mang token: org lấy từ chính intent đã ghi lúc checkout.
    const orgId = intent.organizationId ? intent.organizationId.toString() : null
    await getOrCreateWallet(userId, session, orgId)
    const wallet = await CreditWallet.findOneAndUpdate(
      orgId ? { organizationId: orgId } : { userId },
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
          organizationId: intent.organizationId,
          projectId: null,
          actionType: "purchase",
          amount: intent.credits,
          type: "purchase",
          balanceAfter: wallet.balance - wallet.reserved
        }
      ],
      options
    )

    // Checkout `plan:<id>`: tiền về thì kích hoạt gói trong cùng transaction với cộng credit
    const plan = planFromPackageId(intent.packageId)
    const planChange = plan ? await activatePlan(orgId, userId, plan, session) : null

    return { intent, balance: wallet.balance, planChange }
  })

  if (!processed) return null

  const { intent, balance, planChange } = processed
  const userId = intent.userId.toString()

  if (planChange?.changed) await notifyPlanChanged(userId, planChange)

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

interface PlanChange {
  subscription: unknown
  periodEnd: Date | null
  plan: PlanId
  previousPlan: PlanId | null
  changed: boolean
}

/**
 * Ghi Subscription. Gói trả phí mua lại khi còn hạn thì gia hạn từ cuối kỳ hiện tại;
 * về lại gói miễn phí đang dùng là no-op. Không có side effect ngoài DB (notify gọi sau).
 */
const activatePlan = async (
  orgId: string | null,
  userId: string,
  plan: PlanId,
  session?: ClientSession
): Promise<PlanChange> => {
  const options = sessionOptions(session)
  const definition = getPlan(plan)
  // Gói thuộc về org; intent cũ chưa có org thì lùi về khoá theo người như trước task-26.
  const key = orgId ? { organizationId: orgId } : { userId }
  const current = await Subscription.findOne(key, null, options)
  const previousPlan = (current?.plan as PlanId | undefined) ?? null
  const now = new Date()
  const active = current?.status === "active" && current.plan === plan

  if (active && definition.priceVnd === 0) {
    return { subscription: current, periodEnd: current.currentPeriodEnd ?? null, plan, previousPlan, changed: false }
  }

  const start = active && current.currentPeriodEnd > now ? current.currentPeriodEnd : now
  const periodEnd = new Date(start.getTime() + planConfig.periodDays * 24 * 60 * 60 * 1000)

  const subscription = await Subscription.findOneAndUpdate(
    key,
    {
      $set: {
        plan,
        status: "active",
        monthlyCreditsAllotment: definition.monthlyCredits,
        currentPeriodStart: active ? current.currentPeriodStart : now,
        currentPeriodEnd: periodEnd
      },
      $setOnInsert: {
        userId: new mongoose.Types.ObjectId(userId),
        ...(orgId ? { organizationId: new mongoose.Types.ObjectId(orgId) } : {})
      }
    },
    { ...options, upsert: true, returnDocument: "after" }
  )

  return { subscription, periodEnd, plan, previousPlan, changed: true }
}

const notifyPlanChanged = async (userId: string, change: PlanChange) => {
  const definition = getPlan(change.plan)
  const periodEnd = change.periodEnd
  await notify(userId, {
    type: "plan_changed",
    title: `Đã chuyển sang gói ${definition.label}`,
    body: periodEnd
      ? `Gói ${definition.label} có hiệu lực đến ${new Date(periodEnd).toLocaleDateString("vi-VN")}.`
      : `Gói ${definition.label} đã được kích hoạt.`,
    link: "/home/billing",
    meta: { plan: change.plan, previousPlan: change.previousPlan }
  })
}

/**
 * Đổi gói không qua thanh toán — chỉ cho gói miễn phí. Gói trả phí phải mua qua
 * `POST /billing/checkout { packageId: "plan:<id>" }` (payment_service thật, review T04).
 */
export const upgradePlan = async (orgId: string, userId: string, plan: PlanId) => {
  const definition = getPlan(plan)
  if (definition.priceVnd > 0) {
    throw new ApiError(
      402,
      `Gói ${definition.label} cần thanh toán. Tạo checkout với packageId "${planPackageId(plan)}".`,
      "PAYMENT_REQUIRED"
    )
  }

  const change = await activatePlan(orgId, userId, plan)
  if (change.changed) await notifyPlanChanged(userId, change)
  return change.subscription
}
