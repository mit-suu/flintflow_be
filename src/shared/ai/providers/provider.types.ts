import { AiProviderConfig } from "../ai-action.types.js"

export interface LLMResponse {
  text: string
  promptTokens: number
  completionTokens: number
  raw?: any
}

export type LLMCallFn = (
  prompt: string,
  providerConfig: AiProviderConfig
) => Promise<LLMResponse>
