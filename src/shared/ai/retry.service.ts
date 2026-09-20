import { AiActionError } from "./ai-action.types.js"

export const isTransientError = (error: any): boolean => {
  const errMsg = (error?.message || error?.details?.error?.message || "").toLowerCase()
  if (errMsg.includes("insufficient_quota") || errMsg.includes("exceeded your current quota")) {
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
        const waitMs = backoffMs[attempt] || 2000
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
