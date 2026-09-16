import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse } from "./provider.types.js"
import { callOpenAI } from "./openai.provider.js"
import { callAnthropic } from "./anthropic.provider.js"
import { callGemini } from "./gemini.provider.js"
import { callGLM } from "./glm.provider.js"
import { callMockLLM } from "./mock.provider.js"

export const callLLM = async (
  prompt: string,
  providerConfig: AiProviderConfig
): Promise<LLMResponse> => {
  // `AI_PROVIDER_OVERRIDE` đè frontmatter của skill cho MỌI lượt gọi. Chỉ để CI / smoke test chạy hết
  // một step mà không gọi mạng (`mock`); mọi môi trường thật để trống (T24, `docs/ops.md`).
  const provider = (env.AI_PROVIDER_OVERRIDE || providerConfig.provider || "openai").toLowerCase()

  switch (provider) {
    case "openai":
      return await callOpenAI(prompt, providerConfig)
    case "anthropic":
      return await callAnthropic(prompt, providerConfig)
    case "gemini":
      return await callGemini(prompt, providerConfig)
    case "glm":
    case "modal":
      return await callGLM(prompt, providerConfig)
    case "mock":
      return await callMockLLM(prompt, providerConfig)
    default:
      if (providerConfig.model?.toLowerCase().includes("glm")) {
        return await callGLM(prompt, providerConfig)
      }
      throw new AiActionError(
        500,
        `Unsupported AI provider: ${providerConfig.provider}`,
        "AI_PROVIDER_UNSUPPORTED"
      )
  }
}
