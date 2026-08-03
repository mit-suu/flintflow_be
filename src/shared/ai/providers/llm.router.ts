import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse } from "./provider.types.js"
import { callOpenAI } from "./openai.provider.js"
import { callAnthropic } from "./anthropic.provider.js"
import { callGemini } from "./gemini.provider.js"
import { callMockLLM } from "./mock.provider.js"

export const callLLM = async (
  prompt: string,
  providerConfig: AiProviderConfig
): Promise<LLMResponse> => {
  const provider = (providerConfig.provider || "openai").toLowerCase()

  switch (provider) {
    case "openai":
      return await callOpenAI(prompt, providerConfig)
    case "anthropic":
      return await callAnthropic(prompt, providerConfig)
    case "gemini":
      return await callGemini(prompt, providerConfig)
    case "mock":
      return await callMockLLM(prompt, providerConfig)
    default:
      throw new AiActionError(
        500,
        `Unsupported AI provider: ${providerConfig.provider}`,
        "AI_PROVIDER_UNSUPPORTED"
      )
  }
}
