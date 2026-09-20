import OpenAI from "openai"
import { env } from "../../../config/env.js"
import { AiProviderConfig, AiActionError } from "../ai-action.types.js"
import { LLMResponse, LlmCallOptions } from "./provider.types.js"
import { modalBaseUrl } from "./modal.config.js"

/**
 * GLM-5.x (Modal) có thể trả phần suy nghĩ ngay trong `content`, kết thúc bằng `</think>`, trước câu trả lời thật —
 * parser JSON nhặt nhầm dấu `{` trong phần suy nghĩ ⇒ PARSE_FAILED. Giữ phần sau `</think>` cuối cùng.
 */
export const stripReasoning = (text: string): string => {
  const end = text.lastIndexOf("</think>")
  return end === -1 ? text : text.slice(end + "</think>".length).trimStart()
}

export const GLM_REASONING_HEADROOM_TOKENS = 6144

/**
 * Tham số GLM-5.3-Flash (Modal `/v1/models`: `reasoning_options.effort = low|high|max`, có `json_mode`).
 * Probe prompt S-3.2 thật 2026-09-15: `thinking.type=disabled` vẫn suy nghĩ 10K token tới `finish_reason=length`;
 * `reasoning_effort: "low"` + `json_object` ⇒ ~250 token suy nghĩ, 13 s, lô op hợp lệ. `"none"` không hợp lệ và
 * làm suy nghĩ trộn vào `content`.
 */
export const GLM_REQUEST_OPTIONS = {
  reasoning_effort: "low",
  response_format: { type: "json_object" }
} as const

export const callGLM = async (
  prompt: string,
  providerConfig: AiProviderConfig,
  options: LlmCallOptions = {}
): Promise<LLMResponse> => {
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
      "Modal / GLM credentials are missing. Set MODAL_PROXY_TOKEN_ID and MODAL_PROXY_TOKEN_SECRET (or MODAL_API_KEY) in environment.",
      "MODAL_CREDENTIALS_MISSING"
    )
  }

  const baseURL = modalBaseUrl()

  const client = new OpenAI({
    baseURL,
    apiKey
  })

  const model = providerConfig.model || "zai-org/GLM-5.3-Flash"
  // GLM-5.3 vẫn suy nghĩ ngầm (`reasoning_content`) và phần đó tính vào `max_tokens`: với prompt step thật, 2048
  // token hết trước khi có `content` (M3 2026-09-15). `maxTokens` của skill là ngân sách cho câu trả lời.
  const maxTokens = (providerConfig.maxTokens || 2048) + GLM_REASONING_HEADROOM_TOKENS
  const temperature = providerConfig.temperature ?? 0.3

  try {
    const first = await streamOnce(client, model, prompt, temperature, maxTokens, options.signal)
    if (first.answer) return first.response

    // Prompt khó (C-4 nhiều vị trí) ⇒ model suy nghĩ hết sạch ngân sách, chưa kịp trả `content`. Gọi lại y hệt chỉ
    // hỏng y hệt, nên **nới ngân sách** đúng một lần rồi mới bỏ cuộc.
    if (first.finishReason === "length" && maxTokens < GLM_MAX_TOKENS_CEILING) {
      const retryTokens = Math.min(maxTokens * 2, GLM_MAX_TOKENS_CEILING)
      console.warn(`[GLM] hết ngân sách khi suy nghĩ (max_tokens=${maxTokens}); gọi lại với max_tokens=${retryTokens}`)
      const second = await streamOnce(client, model, prompt, temperature, retryTokens, options.signal)
      if (second.answer) return second.response
      throw emptyOutput(second.finishReason, second.reasoningLength, retryTokens, maxTokens)
    }

    throw emptyOutput(first.finishReason, first.reasoningLength, maxTokens)
  } catch (error: any) {
    if (error instanceof AiActionError) throw error

    const status = error.status || error.response?.status || 500
    const message = error.message || error.response?.data?.error?.message || "GLM API call failed"
    const code = status === 429 ? "RATE_LIMIT_EXCEEDED" : "GLM_ERROR"
    throw new AiActionError(status, message, code, error.response?.data || error)
  }
}

/** Trần ngân sách khi nới: đủ cho lô C-4 lớn, vẫn chặn trường hợp model quay vòng vô tận. */
export const GLM_MAX_TOKENS_CEILING = 24576

const emptyOutput = (finishReason: string | null, reasoningLength: number, maxTokens: number, firstTry?: number): AiActionError =>
  new AiActionError(
    502,
    `GLM không trả nội dung (finish_reason=${finishReason ?? "?"}, suy nghĩ ${reasoningLength} ký tự, max_tokens=${maxTokens}${
      firstTry ? `, đã thử ${firstTry} trước đó` : ""
    })`,
    "GLM_EMPTY_OUTPUT"
  )

interface StreamResult {
  answer: string
  finishReason: string | null
  reasoningLength: number
  response: LLMResponse
}

const streamOnce = async (
  client: OpenAI,
  model: string,
  prompt: string,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal
): Promise<StreamResult> => {
  const stream = (await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ],
    temperature,
    max_tokens: maxTokens,
    top_p: 0.9,
    stream: true,
    ...GLM_REQUEST_OPTIONS
  } as OpenAI.ChatCompletionCreateParamsStreaming,
  // Client đóng kết nối (reload trang) ⇒ bỏ luôn lượt gọi, không chờ model trả hết rồi mới nhả khoá step
  signal ? { signal } : undefined)) as AsyncIterable<OpenAI.ChatCompletionChunk>

  let text = ""
  let reasoningLength = 0
  let finishReason: string | null = null
  let promptTokens = 0
  let completionTokens = 0

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta?.content
    if (delta) {
      text += delta
    }
    reasoningLength += ((choice?.delta as { reasoning_content?: string } | undefined)?.reasoning_content ?? "").length
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if ((chunk as any).usage) {
      promptTokens = (chunk as any).usage.prompt_tokens || promptTokens
      completionTokens = (chunk as any).usage.completion_tokens || completionTokens
    }
  }

  if (!promptTokens) {
    promptTokens = Math.ceil(prompt.length / 4)
  }
  if (!completionTokens) {
    completionTokens = Math.ceil(text.length / 4)
  }

  const answer = stripReasoning(text).trim()
  return { answer, finishReason, reasoningLength, response: { text: answer, promptTokens, completionTokens } }
}
