import { AiActionError } from "./ai-action.types.js"

export const isTransientError = (error: any): boolean => {
  // Người gọi đã bỏ đi (client đóng kết nối) ⇒ gọi lại chỉ tốn tiền và giữ khoá step lâu thêm
  if (error?.name === "AbortError" || error?.name === "APIUserAbortError" || error?.code === "AI_CALL_ABORTED" || error?.code === "ERR_CANCELED") {
    return false
  }
  const errMsg = (error?.message || error?.details?.error?.message || "").toLowerCase()
  // Hết tiền / chưa gắn thanh toán / vượt hạn mức chi: gọi lại chỉ tốn thời gian, trạng thái không tự đổi
  const BILLING = ["insufficient_quota", "exceeded your current quota", "payment method", "spend limit", "credits cannot be applied", "billing"]
  if (BILLING.some((phrase) => errMsg.includes(phrase))) {
    return false
  }

  if (error instanceof AiActionError) {
    if (
      error.code === "INSUFFICIENT_CREDIT" ||
      // `callGLM` đã tự gọi lại một lần với ngân sách gấp đôi trước khi ném lỗi này; lặp y hệt prompt chỉ tốn lượt gọi
      error.code === "GLM_EMPTY_OUTPUT" ||
      error.statusCode === 402 ||
      error.statusCode === 400 ||
      error.statusCode === 403
    ) {
      return false
    }
    if (
      error.code === "RATE_LIMIT_EXCEEDED" ||
      error.code === "PARSE_FAILED" ||
      error.code === "SCHEMA_MISMATCH" ||
      error.statusCode === 429 ||
      error.statusCode >= 500
    ) {
      return true
    }
  }

  // Network or timeout errors
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || error.message?.includes("timeout")) {
    return true
  }

  return false
}

export const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Nhà cung cấp quá tải / chạm hạn mức (503 "high demand", 429, timeout). Đợt quá tải của Gemini thường kéo dài vài giây
 * tới vài chục giây ⇒ chờ 1 s / 3 s như lỗi mạng thường là gọi lại khi vẫn còn quá tải (log 2026-09-24: 3 lượt trượt cả 3).
 */
export const isOverloadError = (error: any): boolean =>
  error instanceof AiActionError &&
  (error.statusCode === 503 || error.statusCode === 429 || ["GEMINI_OVERLOADED", "GEMINI_TIMEOUT", "RATE_LIMIT_EXCEEDED"].includes(error.code))

/** Chờ trước lượt gọi lại khi quá tải (chưa tính `retryDelay` của nhà cung cấp và độ lệch ngẫu nhiên). */
export const OVERLOAD_BACKOFF_MS = [2000, 6000]
/** Trần chờ một lượt — I-4 chạy nền nhưng lượt gọi trong request (chat, step) không được treo quá lâu. */
export const MAX_OVERLOAD_WAIT_MS = 20000

/** `retryDelay` Google gửi kèm lỗi (`error.details[].retryDelay`, dạng `"7s"` / `"1.5s"`) ⇒ ms; không có ⇒ null. */
export const providerRetryDelayMs = (error: any): number | null => {
  const details = error?.details?.error?.details
  if (!Array.isArray(details)) return null
  for (const d of details) {
    const m = typeof d?.retryDelay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay) : null
    if (m) return Math.round(Number(m[1]) * 1000)
  }
  return null
}

/** Thời gian chờ trước lượt `attempt + 2`: quá tải ⇒ lâu hơn, theo `retryDelay` nếu có, cộng 0–30% ngẫu nhiên để nhiều lượt gọi không dồn cùng lúc. */
export const retryWaitMs = (error: any, attempt: number, backoffMs: number[], random: () => number = Math.random): number => {
  if (!isOverloadError(error)) return backoffMs[attempt] || 2000
  const base = Math.max(OVERLOAD_BACKOFF_MS[attempt] ?? OVERLOAD_BACKOFF_MS[OVERLOAD_BACKOFF_MS.length - 1], providerRetryDelayMs(error) ?? 0)
  return Math.min(MAX_OVERLOAD_WAIT_MS, Math.round(base * (1 + 0.3 * random())))
}

export const executeWithInRequestRetry = async <T>(
  fn: (attempt: number) => Promise<T>,
  maxRetries: number = 2,
  backoffMs: number[] = [1000, 3000]
): Promise<T> => {
  let lastError: any

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error

      if (attempt < maxRetries && isTransientError(error)) {
        const waitMs = retryWaitMs(error, attempt, backoffMs)
        const errMsg = (error as any)?.message || String(error)
        console.warn(`[AiRetry] Transient error on attempt ${attempt + 1}/${maxRetries + 1}. Retrying in ${waitMs}ms...`, errMsg)
        await delay(waitMs)
      } else {
        throw error
      }
    }
  }

  throw lastError
}
