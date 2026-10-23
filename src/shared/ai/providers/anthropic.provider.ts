import axios from "axios"
import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse, LlmCallOptions } from "./provider.types.js"

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5"

/**
 * Claude 5.x luôn suy nghĩ (adaptive thinking) và phần suy nghĩ ăn vào `max_tokens`. `maxTokens` trong frontmatter
 * của skill là ngân sách cho câu trả lời, nên cộng thêm phần đệm này — giống `GLM_REASONING_HEADROOM_TOKENS`.
 */
export const ANTHROPIC_THINKING_HEADROOM_TOKENS = 4096

/**
 * Tham số chung cho cả `callAnthropic` lẫn đường stream (AI SDK): suy nghĩ ít (`effort: low`, tương đương
 * `reasoning_effort: "low"` của GLM). Không gửi `temperature` — Sonnet 5.5 trả 400 với giá trị khác mặc định.
 */
export const ANTHROPIC_EFFORT = "low"

export const anthropicMaxTokens = (providerConfig: AiProviderConfig): number =>
  (providerConfig.maxTokens || 2048) + ANTHROPIC_THINKING_HEADROOM_TOKENS

export const callAnthropic = async (
  prompt: string,
  providerConfig: AiProviderConfig,
  options: LlmCallOptions = {}
): Promise<LLMResponse> => {
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new AiActionError(500, "Anthropic API key is missing. Set ANTHROPIC_API_KEY in environment.", "ANTHROPIC_KEY_MISSING")
  }

  const model = providerConfig.model || DEFAULT_ANTHROPIC_MODEL

  let data: any
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model,
        max_tokens: anthropicMaxTokens(providerConfig),
        output_config: { effort: ANTHROPIC_EFFORT },
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        // Lượt sinh section dài (maxTokens tới 12288) có thể quá 60s
        timeout: 180000,
        ...(options.signal ? { signal: options.signal } : {})
      }
    )
    data = response.data
  } catch (error: any) {
    const status = error.response?.status || 500
    const message = error.response?.data?.error?.message || error.message || "Anthropic API call failed"
    const code = status === 429 ? "RATE_LIMIT_EXCEEDED" : "ANTHROPIC_ERROR"
    throw new AiActionError(status, message, code, error.response?.data)
  }

  if (data?.stop_reason === "refusal") {
    throw new AiActionError(502, "Anthropic từ chối trả lời (stop_reason=refusal)", "ANTHROPIC_REFUSAL", data?.stop_details)
  }
  if (data?.stop_reason === "max_tokens") {
    throw new AiActionError(
      422,
      `Anthropic response was truncated (max_tokens=${anthropicMaxTokens(providerConfig)}). Increase maxTokens in the prompt template.`,
      "RESPONSE_TRUNCATED"
    )
  }

  // content mở đầu bằng khối `thinking` (text rỗng) — chỉ ghép các khối `text`
  const text = (data?.content ?? [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("")

  return {
    text,
    promptTokens: data?.usage?.input_tokens || 0,
    completionTokens: data?.usage?.output_tokens || 0,
    raw: data
  }
}
