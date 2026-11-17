/**
 * provider-error.ts — FLF-433 (FAP #17): mã lỗi theo nội dung lỗi của nhà cung cấp AI.
 *
 * 429 / 400 / 402 do **hết hạn mức / billing** (hết tiền, chưa gắn thanh toán, vượt hạn mức chi, "credit balance is too low" của
 * Anthropic) không phải quá tải: gọi lại bao nhiêu lần cũng không qua. Trước đây mọi 429 thành `RATE_LIMIT_EXCEEDED` ⇒ người
 * dùng đọc "Dịch vụ AI đang quá tải. Vui lòng thử lại sau ít phút" và thử lại mãi.
 */
export const PROVIDER_BILLING_PHRASES: readonly string[] = [
  "insufficient_quota",
  "exceeded your current quota",
  "payment method",
  "spend limit",
  "credits cannot be applied",
  "billing",
  "credit balance is too low",
  "purchase credits"
]

export const isProviderBillingMessage = (message: string | null | undefined): boolean => {
  const text = (message ?? "").toLowerCase()
  return PROVIDER_BILLING_PHRASES.some((phrase) => text.includes(phrase))
}

/** Mã lỗi khi nhà cung cấp hết hạn mức / billing — câu cho người dùng ở `client-error.ts`. */
export const AI_PROVIDER_QUOTA = "AI_PROVIDER_QUOTA"

/** Mã lỗi của một lượt gọi provider hỏng: billing trước, rồi 429 quá tải, rồi mã mặc định của provider. */
export const providerErrorCode = (status: number, message: string | null | undefined, fallback: string, overloaded?: string): string => {
  if (isProviderBillingMessage(message)) return AI_PROVIDER_QUOTA
  if (status === 429) return "RATE_LIMIT_EXCEEDED"
  if (status === 503 && overloaded) return overloaded
  return fallback
}
