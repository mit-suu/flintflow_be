import { describe, expect, it } from "vitest"
import { AiActionError } from "./ai-action.types.js"
import { MAX_OVERLOAD_WAIT_MS, isOverloadError, providerRetryDelayMs, retryWaitMs } from "./retry.service.js"

const overloaded = (retryDelay?: string) =>
  new AiActionError(503, "high demand", "GEMINI_OVERLOADED", retryDelay ? { error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] } } : undefined)

describe("retry — chờ khi nhà cung cấp quá tải", () => {
  it("503 / 429 / timeout Gemini là quá tải; lỗi 500 thường không", () => {
    expect(isOverloadError(overloaded())).toBe(true)
    expect(isOverloadError(new AiActionError(429, "rate", "RATE_LIMIT_EXCEEDED"))).toBe(true)
    expect(isOverloadError(new AiActionError(504, "slow", "GEMINI_TIMEOUT"))).toBe(true)
    expect(isOverloadError(new AiActionError(500, "boom", "GLM_ERROR"))).toBe(false)
  })

  it("quá tải chờ 2 s rồi 6 s (+0–30% ngẫu nhiên); lỗi thường giữ backoff cũ", () => {
    expect(retryWaitMs(overloaded(), 0, [1000, 3000], () => 0)).toBe(2000)
    expect(retryWaitMs(overloaded(), 1, [1000, 3000], () => 1)).toBe(7800)
    expect(retryWaitMs(new AiActionError(500, "boom", "GLM_ERROR"), 0, [1000, 3000])).toBe(1000)
  })

  it("theo `retryDelay` Google gửi nếu lâu hơn, không quá trần", () => {
    expect(providerRetryDelayMs(overloaded("7s"))).toBe(7000)
    expect(providerRetryDelayMs(overloaded("1.5s"))).toBe(1500)
    expect(providerRetryDelayMs(new AiActionError(503, "x", "GEMINI_OVERLOADED"))).toBeNull()
    expect(retryWaitMs(overloaded("7s"), 0, [1000, 3000], () => 0)).toBe(7000)
    expect(retryWaitMs(overloaded("90s"), 0, [1000, 3000], () => 0)).toBe(MAX_OVERLOAD_WAIT_MS)
  })
})
