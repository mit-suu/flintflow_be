import { AiProviderConfig } from "../ai-action.types.js"

export interface LLMResponse {
  text: string
  promptTokens: number
  completionTokens: number
  raw?: any
}

/** Tuỳ chọn cho một lượt gọi model (khác cấu hình skill): huỷ khi người gọi đã bỏ đi. */
export interface LlmCallOptions {
  signal?: AbortSignal
}

export type LLMCallFn = (
  prompt: string,
  providerConfig: AiProviderConfig,
  options?: LlmCallOptions
) => Promise<LLMResponse>
