/**
 * plan.config.ts
 * ─────────────────────────────────────────────────────────────────
 * Nguồn duy nhất cho số credit tặng, ngưỡng cảnh báo và gói nạp credit.
 * Trước đây `getOrCreateWallet` tặng cứng 100 credit (audit E1).
 *
 * TODO(monthly_reset): cron reset quota hằng tháng theo
 * `Subscription.monthlyCreditsAllotment` (ghi CreditTransaction type
 * `monthly_reset`) để ngoài vòng một — xem task-04 "Ghi chú / rủi ro".
 */

export type PlanId = "free" | "pro"

export interface PlanDefinition {
  id: PlanId
  label: string
  /** Credit tặng khi tạo ví lần đầu (chỉ áp dụng cho free). */
  initialCredits: number
  /** Hạn mức mỗi kỳ — ghi vào Subscription.monthlyCreditsAllotment. */
  monthlyCredits: number
  /** Giá mỗi kỳ (VND). Gói > 0đ chỉ kích hoạt qua checkout `plan:<id>` (thanh toán thật). */
  priceVnd: number
}

export interface CreditPackage {
  id: string
  label: string
  credits: number
  amount: number
  currency: "VND"
}

export const planConfig = {
  free: {
    id: "free",
    label: "Free",
    initialCredits: 100,
    monthlyCredits: 100,
    priceVnd: 0
  } satisfies PlanDefinition,
  pro: {
    id: "pro",
    label: "Pro",
    initialCredits: 0,
    monthlyCredits: 1000,
    priceVnd: 199_000
  } satisfies PlanDefinition,
  /** Số dư (balance) rơi xuống dưới ngưỡng này thì gửi notification một lần. */
  lowCreditThreshold: 10,
  /** Kỳ subscription (ngày). */
  periodDays: 30,
  packages: [
    { id: "pack_100", label: "Gói 100 credit", credits: 100, amount: 4_000, currency: "VND" },
    { id: "pack_500", label: "Gói 500 credit", credits: 500, amount: 199_000, currency: "VND" },
    { id: "pack_1500", label: "Gói 1500 credit", credits: 1500, amount: 499_000, currency: "VND" }
  ] satisfies CreditPackage[]
}

export const PLAN_IDS: PlanId[] = ["free", "pro"]

export const getPlan = (plan: PlanId): PlanDefinition => planConfig[plan]

/** Checkout mua gói trả phí dùng packageId `plan:<id>` (vd `plan:pro`). */
export const PLAN_PACKAGE_PREFIX = "plan:"

export const planPackageId = (plan: PlanId): string => `${PLAN_PACKAGE_PREFIX}${plan}`

export const planFromPackageId = (packageId: string): PlanId | null => {
  if (!packageId.startsWith(PLAN_PACKAGE_PREFIX)) return null
  const plan = packageId.slice(PLAN_PACKAGE_PREFIX.length)
  return PLAN_IDS.find((id) => id === plan) ?? null
}

/**
 * Gói credit, hoặc gói subscription trả phí dạng package: thanh toán `priceVnd`,
 * nhận ngay `monthlyCredits` của kỳ đầu và kích hoạt Subscription khi tiền về.
 */
export const findPackage = (packageId: string): CreditPackage | undefined => {
  const plan = planFromPackageId(packageId)
  if (plan) {
    const definition = getPlan(plan)
    if (definition.priceVnd <= 0) return undefined
    return {
      id: packageId,
      label: `Gói ${definition.label} (${planConfig.periodDays} ngày)`,
      credits: definition.monthlyCredits,
      amount: definition.priceVnd,
      currency: "VND"
    }
  }
  return planConfig.packages.find((p) => p.id === packageId)
}
