import axios from "axios"
import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse, LlmCallOptions } from "./provider.types.js"

export const callOpenAI = async (
  prompt: string,
  providerConfig: AiProviderConfig,
  options: LlmCallOptions = {}
): Promise<LLMResponse> => {
  const apiKey = env.OPENAI_API_KEY
  if (!apiKey) {
    throw new AiActionError(500, "OpenAI API key is missing. Set OPENAI_API_KEY in environment.", "OPENAI_KEY_MISSING")
  }

  const model = providerConfig.model || "gpt-4o-mini"
  const maxTokens = providerConfig.maxTokens || 2048
  const temperature = providerConfig.temperature ?? 0.7

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        timeout: 60000,
        ...(options.signal ? { signal: options.signal } : {})
      }
    )

    const text = response.data?.choices?.[0]?.message?.content || ""
    const promptTokens = response.data?.usage?.prompt_tokens || 0
    const completionTokens = response.data?.usage?.completion_tokens || 0

    return {
      text,
      promptTokens,
      completionTokens,
      raw: response.data
    }
  } catch (error: any) {
    const status = error.response?.status || 500
    const message = error.response?.data?.error?.message || error.message || "OpenAI API call failed"
    const code = status === 429 ? "RATE_LIMIT_EXCEEDED" : "OPENAI_ERROR"
    throw new AiActionError(status, message, code, error.response?.data)
  }
}
