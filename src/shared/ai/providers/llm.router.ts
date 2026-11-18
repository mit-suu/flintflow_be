import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse, LlmCallOptions } from "./provider.types.js"
import { callAnthropic } from "./anthropic.provider.js"
import { callGemini } from "./gemini.provider.js"
import { callGLM } from "./glm.provider.js"
import { callMockLLM } from "./mock.provider.js"

/**
 * Luật dấu câu cho mọi chữ AI viết ra (tài liệu, chat, tin nhắn): không dùng em dash, dùng gạch ngắn.
 * Gắn ở đây vì mọi lượt gọi model đều đi qua `callLLM`, không phải lặp lại trong từng skill.
 * Chữ chép nguyên văn từ tài liệu của khách giữ dấu gốc.
 */
export const PUNCTUATION_RULE =
  "Punctuation rule for every text you write: never use the em dash character (—); use a plain hyphen (-) instead, " +
  'e.g. "A - B". Exception: text copied verbatim from the customer\'s own documents keeps its original punctuation.'

export const callLLM = async (
  rawPrompt: string,
  providerConfig: AiProviderConfig,
  options: LlmCallOptions = {}
): Promise<LLMResponse> => {
  const prompt = `${rawPrompt}\n\n${PUNCTUATION_RULE}`
  // `AI_PROVIDER_OVERRIDE` đè frontmatter của skill cho MỌI lượt gọi. Chỉ để CI / smoke test chạy hết
  // một step mà không gọi mạng (`mock`); mọi môi trường thật để trống (T24, `docs/ops.md`).
  const provider = (env.AI_PROVIDER_OVERRIDE || providerConfig.provider || "glm").toLowerCase()
  // Chỉ cho phép provider đã có hỗ trợ gửi ảnh; tránh model chỉ thấy chữ và bịa nội dung ảnh.
  if (options.images?.length && provider !== "anthropic" && provider !== "gemini" && provider !== "mock") {
    throw new AiActionError(500, `Provider ${provider} does not accept images`, "AI_PROVIDER_NO_VISION")
  }

  switch (provider) {
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
