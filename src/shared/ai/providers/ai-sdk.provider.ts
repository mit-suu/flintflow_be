import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createAnthropic } from "@ai-sdk/anthropic"
import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { GLM_REQUEST_OPTIONS } from "./glm.provider.js"

/**
 * GLM-5.3-Flash trên Modal cần `reasoning_effort: "low"` + `json_object` (xem `GLM_REQUEST_OPTIONS`), nếu không
 * suy nghĩ lan man tới hết token. Chèn thẳng vào body request để không phụ thuộc option của AI SDK.
 */
export const glmFetch: typeof fetch = (input, init) => {
  if (typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>
      return fetch(input, { ...init, body: JSON.stringify({ ...body, ...GLM_REQUEST_OPTIONS }) })
    } catch {
      // body không phải JSON — gửi nguyên
    }
  }
  return fetch(input, init)
}

export const getAiSdkModel = (providerConfig: AiProviderConfig) => {
  const provider = (providerConfig.provider || "openai").toLowerCase()
  const modelName = providerConfig.model

  switch (provider) {
    case "glm":
    case "modal": {
      const tokenId = (env.MODAL_PROXY_TOKEN_ID || process.env.MODAL_PROXY_TOKEN_ID)?.trim()
      const tokenSecret = (env.MODAL_PROXY_TOKEN_SECRET || process.env.MODAL_PROXY_TOKEN_SECRET)?.trim()
      const rawApiKey = (env.MODAL_API_KEY || process.env.MODAL_API_KEY)?.trim()?.replace(/\.+$/, "")

      let apiKey = ""
      if (tokenId && tokenSecret) {
        apiKey = `${tokenId}.${tokenSecret}`
      } else if (rawApiKey) {
        apiKey = rawApiKey
      }

      if (!apiKey) {
        throw new AiActionError(
          500,
          "Modal / GLM credentials are missing. Set MODAL_PROXY_TOKEN_ID and MODAL_PROXY_TOKEN_SECRET in environment.",
          "MODAL_CREDENTIALS_MISSING"
        )
      }

      const baseURL =
        env.MODAL_BASE_URL ||
        "https://trantuanhiep28122003--ep-mary-flintflow-analysis-server.us-west.modal.direct/v1"

      const modalOpenAi = createOpenAI({
        baseURL,
        apiKey,
        fetch: glmFetch
      })

      return modalOpenAi.chat(modelName || "zai-org/GLM-5.3-Flash")
    }

    case "openai": {
      const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY
      if (!apiKey) {
        throw new AiActionError(
          500,
          "OpenAI API key is missing. Set OPENAI_API_KEY in environment.",
          "OPENAI_KEY_MISSING"
        )
      }

      const openai = createOpenAI({ apiKey })
      return openai.chat(modelName || "gpt-4o-mini")
    }

    case "gemini": {
      const apiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY
      if (!apiKey) {
        throw new AiActionError(
          500,
          "Gemini API key is missing. Set GEMINI_API_KEY in environment.",
          "GEMINI_KEY_MISSING"
        )
      }

      const google = createGoogleGenerativeAI({ apiKey })
      return google(modelName || "gemini-1.5-flash")
    }

    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
      if (!apiKey) {
        throw new AiActionError(
          500,
          "Anthropic API key is missing. Set ANTHROPIC_API_KEY in environment.",
          "ANTHROPIC_KEY_MISSING"
        )
      }

      const anthropic = createAnthropic({ apiKey })
      return anthropic(modelName || "claude-3-5-sonnet-20241022")
    }

    default: {
      if (modelName?.toLowerCase().includes("glm")) {
        const baseURL =
          env.MODAL_BASE_URL ||
          "https://trantuanhiep28122003--ep-mary-flintflow-analysis-server.us-west.modal.direct/v1"
        const apiKey = env.MODAL_API_KEY || process.env.MODAL_API_KEY || ""
        const modalOpenAi = createOpenAI({ baseURL, apiKey, fetch: glmFetch })
        return modalOpenAi.chat(modelName)
      }

      const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY
      if (!apiKey) {
        throw new AiActionError(
          500,
          `Unsupported provider: ${providerConfig.provider}`,
          "AI_PROVIDER_UNSUPPORTED"
        )
      }
      const openai = createOpenAI({ apiKey })
      return openai.chat(modelName || "gpt-4o-mini")
    }
  }
}
