import crypto from "crypto"
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

export type MockWebhookStatus = "success" | "failed"

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

// ─── Chữ ký webhook mock ─────────────────────────────────────────────

/** Chuỗi được ký: `<intentId>.<status>` — tránh phụ thuộc thứ tự key JSON. */
export const signMockWebhook = (intentId: string, status: MockWebhookStatus): string =>
  crypto
    .createHmac("sha256", env.PAYMENT_WEBHOOK_SECRET)
    .update(`${intentId}.${status}`)
    .digest("hex")

export const verifyMockWebhookSignature = (
  intentId: string,
  status: MockWebhookStatus,
  signature: string | undefined
): boolean => {
  if (!signature) return false
  const expected = Buffer.from(signMockWebhook(intentId, status), "hex")
  const provided = Buffer.from(signature, "hex")
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided)
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
  processedAt: intent.processedAt ?? null,
  createdAt: intent.createdAt
})

const buildRedirectUrl = (intentId: string): string => {
  const url = new URL(env.MOCK_PAYMENT_URL)
  url.searchParams.set("intentId", intentId)
  return url.toString()
}

export const createCheckout = async (userId: string, packageId: string) => {
  const pkg = findPackage(packageId)
  if (!pkg) {
    throw new ApiError(404, "Không tìm thấy gói credit", "PACKAGE_NOT_FOUND")
  }

  const intent = await PaymentIntent.create({
    userId: new mongoose.Types.ObjectId(userId),
    packageId: pkg.id,
    credits: pkg.credits,
    amount: pkg.amount,
    currency: pkg.currency,
    provider: "mock",
    status: "pending"
  })

  const intentId = intent._id.toString()
  return { ...toIntentDTO(intent), redirectUrl: buildRedirectUrl(intentId) }
}

/**
 * Trang mock checkout đóng vai cổng thanh toán: cổng thật giữ secret phía nó,
 * còn cổng giả chạy trong trình duyệt nên BE ký sẵn hai kết quả cho intent
 * đang pending của chính chủ.
 */
export const getCheckout = async (userId: string, intentId: string) => {
  if (!mongoose.isValidObjectId(intentId)) {
    throw new ApiError(400, "ID giao dịch không hợp lệ", "INVALID_INTENT_ID")
  }

  const intent = await PaymentIntent.findOne({ _id: intentId, userId })
  if (!intent) {
    throw new ApiError(404, "Không tìm thấy giao dịch", "INTENT_NOT_FOUND")
  }

  const dto = toIntentDTO(intent)
  if (intent.status !== "pending") return { ...dto, mockSignatures: null }

  return {
    ...dto,
    mockSignatures: {
      success: signMockWebhook(dto.intentId, "success"),
      failed: signMockWebhook(dto.intentId, "failed")
    }
  }
}

// ─── Webhook ─────────────────────────────────────────────────────────

export interface MockWebhookResult {
  intentId: string
  status: IPaymentIntent["status"]
  alreadyProcessed: boolean
  creditsAdded: number
  balance?: number
}

export const handleMockWebhook = async (
  intentId: string,
  status: MockWebhookStatus,
  signature: string | undefined
): Promise<MockWebhookResult> => {
  if (!verifyMockWebhookSignature(intentId, status, signature)) {
    throw new ApiError(401, "Chữ ký webhook không hợp lệ", "INVALID_WEBHOOK_SIGNATURE")
  }

  const nextStatus = status === "success" ? "succeeded" : "failed"

  const processed = await withOptionalTransaction(async (session) => {
    const options = sessionOptions(session)

    // Idempotent theo intentId: chỉ intent còn pending mới được chuyển trạng thái.
    const intent = await PaymentIntent.findOneAndUpdate(
      { _id: intentId, status: "pending" },
      { $set: { status: nextStatus, processedAt: new Date() } },
      { ...options, returnDocument: "after" }
    )
    if (!intent) return null

    if (nextStatus === "failed") {
      return { intent, balance: undefined }
    }

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

  if (!processed) {
    const existing = await PaymentIntent.findOne({ _id: intentId })
    if (!existing) {
      throw new ApiError(404, "Không tìm thấy giao dịch", "INTENT_NOT_FOUND")
    }
    return {
      intentId,
      status: existing.status,
      alreadyProcessed: true,
      creditsAdded: 0
    }
  }

  const { intent, balance } = processed
  const userId = intent.userId.toString()

  if (intent.status === "succeeded") {
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
      body: "Giao dịch nạp credit không thành công. Bạn chưa bị trừ tiền.",
      link: "/home/billing",
      meta: { intentId, amount: intent.amount }
    })
  }

  return {
    intentId,
    status: intent.status,
    alreadyProcessed: false,
    creditsAdded: intent.status === "succeeded" ? intent.credits : 0,
    balance
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
