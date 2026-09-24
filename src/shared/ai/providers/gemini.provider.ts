import axios from "axios"
import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse, LlmCallOptions } from "./provider.types.js"

/** Hết tiền / chưa gắn thanh toán: đổi model không giúp gì. */
const BILLING_PHRASES = ["insufficient_quota", "exceeded your current quota", "billing", "payment method", "spend limit"]

/**
 * Model đang quá tải hoặc chạm hạn mức theo model (503 "high demand", 429 không phải hết tiền, 500/504, timeout) — model
 * khác cùng key thường vẫn trả lời được ngay (đo 2026-09-24: `gemini-3.5-flash` 503 liên tục, `gemini-3.6-flash` 200).
 */
export const isGeminiOverloaded = (error: unknown): boolean => {
  if (!(error instanceof AiActionError)) return false
  if (error.code === "GEMINI_TIMEOUT") return true
  const message = error.message.toLowerCase()
  if (BILLING_PHRASES.some((p) => message.includes(p))) return false
  return [429, 500, 503, 504].includes(error.statusCode)
}

/**
 * Gọi Gemini: model chính rồi lần lượt `providerConfig.fallbackModels` khi model trước quá tải. Lỗi khác (key sai, prompt
 * hỏng, ảnh không nhận…) ném ngay — model khác cũng sẽ lỗi y vậy. Mọi model đều quá tải ⇒ ném lỗi của model cuối, kèm danh
 * sách model đã thử; `executeWithInRequestRetry` chờ rồi gọi lại cả vòng.
 */
export const callGemini = async (
  prompt: string,
  providerConfig: AiProviderConfig,
  options: LlmCallOptions = {}
): Promise<LLMResponse> => {
  const primary = providerConfig.model || "gemini-3.5-flash"
  const models = [...new Set([primary, ...(providerConfig.fallbackModels ?? [])])]
  let lastError: unknown
  for (const [i, model] of models.entries()) {
    try {
      return await callGeminiModel(prompt, model, providerConfig, options)
    } catch (error) {
      lastError = error
      if (!isGeminiOverloaded(error) || options.signal?.aborted) throw error
      if (i < models.length - 1) console.warn(`[Gemini] ${model} quá tải (${(error as AiActionError).statusCode}) — chuyển sang ${models[i + 1]}`)
    }
  }
  const err = lastError as AiActionError
  if (models.length > 1) err.message = `${err.message} (đã thử ${models.join(", ")})`
  throw err
}

const callGeminiModel = async (
  prompt: string,
  model: string,
  providerConfig: AiProviderConfig,
  options: LlmCallOptions
): Promise<LLMResponse> => {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) {
    throw new AiActionError(500, "Gemini API key is missing. Set GEMINI_API_KEY in environment.", "GEMINI_KEY_MISSING")
  }

  const maxTokens = providerConfig.maxTokens || 2048
  const temperature = providerConfig.temperature ?? 0.7

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    const requestBody = {
      // Ảnh (phase 5) đi sau chữ, dạng inline_data base64 — prompt nhắc tới "ảnh đính kèm"
      contents: [{ parts: [{ text: prompt }, ...(options.images ?? []).map((img) => ({ inline_data: { mime_type: img.mime, data: img.data } }))] }],
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        // Force Gemini to always return valid JSON — prevents plain-text responses
        responseMimeType: "application/json"
      }
    }

    const response = await axios.post(url, requestBody, {
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 60000,
      ...(options.signal ? { signal: options.signal } : {})
    })

    const candidate = response.data?.candidates?.[0]

    // Detect truncated response: finishReason="MAX_TOKENS" means JSON was cut off
    const finishReason = candidate?.finishReason
    if (finishReason === "MAX_TOKENS") {
      throw new AiActionError(
        422,
        `Gemini response was truncated (MAX_TOKENS reached). Increase maxTokens in the prompt template.`,
        "RESPONSE_TRUNCATED"
      )
    }

    const text = candidate?.content?.parts?.[0]?.text || ""
    const promptTokens = response.data?.usageMetadata?.promptTokenCount || 0
    const completionTokens = response.data?.usageMetadata?.candidatesTokenCount || 0

    return {
      text,
      promptTokens,
      completionTokens,
      raw: response.data,
      model
    }
  } catch (error: any) {
    // Re-throw AiActionError (our own errors) as-is
    if (error instanceof AiActionError) throw error

    // Timeout của axios không có response — coi như model đang chậm/quá tải (thử model khác), không phải lỗi 500 thật
    if (!error.response && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")) {
      throw new AiActionError(504, `Gemini ${model} không trả lời kịp (${error.message})`, "GEMINI_TIMEOUT")
    }
    const status = error.response?.status || 500
    const message = error.response?.data?.error?.message || error.message || "Gemini API call failed"
    const code = status === 429 ? "RATE_LIMIT_EXCEEDED" : status === 503 ? "GEMINI_OVERLOADED" : "GEMINI_ERROR"
    throw new AiActionError(status, message, code, error.response?.data)
  }
}
