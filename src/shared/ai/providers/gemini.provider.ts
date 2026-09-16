import axios from "axios"
import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse } from "./provider.types.js"

export const callGemini = async (
  prompt: string,
  providerConfig: AiProviderConfig
): Promise<LLMResponse> => {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) {
    throw new AiActionError(500, "Gemini API key is missing. Set GEMINI_API_KEY in environment.", "GEMINI_KEY_MISSING")
  }

  const model = providerConfig.model || "gemini-3.5-flash"
  const maxTokens = providerConfig.maxTokens || 2048
  const temperature = providerConfig.temperature ?? 0.7

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
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
      timeout: 60000
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
      raw: response.data
    }
  } catch (error: any) {
    // Re-throw AiActionError (our own errors) as-is
    if (error instanceof AiActionError) throw error

    const status = error.response?.status || 500
    const message = error.response?.data?.error?.message || error.message || "Gemini API call failed"
    const code = status === 429 ? "RATE_LIMIT_EXCEEDED" : "GEMINI_ERROR"
    throw new AiActionError(status, message, code, error.response?.data)
  }
}
