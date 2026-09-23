import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse, LlmCallOptions } from "./provider.types.js"
import { callOpenAI } from "./openai.provider.js"
import { callAnthropic } from "./anthropic.provider.js"
import { callGemini } from "./gemini.provider.js"
import { callGLM } from "./glm.provider.js"
import { callMockLLM } from "./mock.provider.js"

export const callLLM = async (
  prompt: string,
  providerConfig: AiProviderConfig,
  options: LlmCallOptions = {}
): Promise<LLMResponse> => {
  // `AI_PROVIDER_OVERRIDE` đè frontmatter của skill cho MỌI lượt gọi. Chỉ để CI / smoke test chạy hết
  // một step mà không gọi mạng (`mock`); mọi môi trường thật để trống (T24, `docs/ops.md`).
  const provider = (env.AI_PROVIDER_OVERRIDE || providerConfig.provider || "openai").toLowerCase()
  // Chỉ Gemini (và mock) nhận ảnh — gửi ảnh cho provider khác thì model chỉ thấy chữ và bịa nội dung ảnh
  if (options.images?.length && provider !== "gemini" && provider !== "mock") {
    throw new AiActionError(500, `Provider ${provider} does not accept images`, "AI_PROVIDER_NO_VISION")
  }

  switch (provider) {
    case "openai":
      return await callOpenAI(prompt, providerConfig, options)
    case "anthropic":
      return await callAnthropic(prompt, providerConfig, options)
    case "gemini":
      return await callGemini(prompt, providerConfig, options)
    case "glm":
    case "modal":
      return await callGLM(prompt, providerConfig, options)
    case "mock":
      return await callMockLLM(prompt, providerConfig, options)
    default:
      if (providerConfig.model?.toLowerCase().includes("glm")) {
        return await callGLM(prompt, providerConfig, options)
      }
      throw new AiActionError(
        500,
        `Unsupported AI provider: ${providerConfig.provider}`,
        "AI_PROVIDER_UNSUPPORTED"
      )
  }
}
