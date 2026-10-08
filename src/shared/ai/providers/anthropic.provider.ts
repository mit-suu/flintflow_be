import axios from "axios"
import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse, LlmCallOptions } from "./provider.types.js"

export const callAnthropic = async (
  prompt: string,
  providerConfig: AiProviderConfig,
  options: LlmCallOptions = {}
): Promise<LLMResponse> => {
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new AiActionError(500, "Anthropic API key is missing. Set ANTHROPIC_API_KEY in environment.", "ANTHROPIC_KEY_MISSING")
  }

  const model = providerConfig.model || "claude-3-5-sonnet-20241022"
  const maxTokens = providerConfig.maxTokens || 2048
  const temperature = providerConfig.temperature ?? 0.7

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        timeout: 60000,
        ...(options.signal ? { signal: options.signal } : {})
      }
    )

    const text = response.data?.content?.[0]?.text || ""
    const promptTokens = response.data?.usage?.input_tokens || 0
    const completionTokens = response.data?.usage?.output_tokens || 0

    return {
      text,
      promptTokens,
      completionTokens,
      raw: response.data
    }
  } catch (error: any) {
    const status = error.response?.status || 500
    const message = error.response?.data?.error?.message || error.message || "Anthropic API call failed"
    const code = status === 429 ? "RATE_LIMIT_EXCEEDED" : "ANTHROPIC_ERROR"
    throw new AiActionError(status, message, code, error.response?.data)
  }
}
