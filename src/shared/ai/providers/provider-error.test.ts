import { describe, expect, it } from "vitest"
import { AiActionError } from "../ai-action.types.js"
import { isTransientError } from "../retry.service.js"
import { aiErrorMessage, AI_OVERLOADED_MESSAGE, AI_PROVIDER_QUOTA_MESSAGE } from "../../utils/client-error.js"
import { AI_PROVIDER_QUOTA, isProviderBillingMessage, providerErrorCode } from "./provider-error.js"

describe("FLF-433 (FAP #17) - lỗi hết hạn mức / billing của nhà cung cấp AI", () => {
  it("429 / 400 kèm câu billing ⇒ AI_PROVIDER_QUOTA; 429 thường ⇒ RATE_LIMIT_EXCEEDED; 503 Gemini ⇒ quá tải", () => {
    expect(providerErrorCode(429, "You exceeded your current quota, please check your plan and billing details", "GEMINI_ERROR")).toBe(AI_PROVIDER_QUOTA)
    expect(providerErrorCode(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing", "ANTHROPIC_ERROR")).toBe(AI_PROVIDER_QUOTA)
    expect(providerErrorCode(429, "Number of request tokens has exceeded your per-minute rate limit", "ANTHROPIC_ERROR")).toBe("RATE_LIMIT_EXCEEDED")
    expect(providerErrorCode(503, "The model is overloaded", "GEMINI_ERROR", "GEMINI_OVERLOADED")).toBe("GEMINI_OVERLOADED")
    expect(providerErrorCode(500, "boom", "GLM_ERROR")).toBe("GLM_ERROR")
  })

  it("không thử lại lỗi billing; câu cho người dùng nói rõ hết hạn mức, không phải quá tải", () => {
    expect(isProviderBillingMessage("insufficient_quota")).toBe(true)
    expect(isTransientError(new AiActionError(429, "Your credit balance is too low", AI_PROVIDER_QUOTA))).toBe(false)
    expect(isTransientError(new AiActionError(429, "rate limited", "RATE_LIMIT_EXCEEDED"))).toBe(true)
    expect(aiErrorMessage(AI_PROVIDER_QUOTA, "x")).toBe(AI_PROVIDER_QUOTA_MESSAGE)
    expect(aiErrorMessage("RATE_LIMIT_EXCEEDED", "x")).toBe(AI_OVERLOADED_MESSAGE)
  })
})
