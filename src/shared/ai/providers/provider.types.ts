import { AiProviderConfig } from "../ai-action.types.js"

export interface LLMResponse {
  text: string
  promptTokens: number
  completionTokens: number
  raw?: any
  /** Model thật sự trả lời (khác `providerConfig.model` khi đã chuyển sang model dự phòng) — ghi vào log / chi phí. */
  model?: string
}

/** Ảnh gửi kèm prompt (mode 1 v3 phase 5 — đọc ảnh diagram). `data` là base64, không tiền tố `data:`. */
export interface LlmImage {
  mime: "image/png" | "image/jpeg"
  data: string
}

/** Tuỳ chọn cho một lượt gọi model (khác cấu hình skill): huỷ khi người gọi đã bỏ đi; ảnh kèm theo (chỉ provider có vision). */
export interface LlmCallOptions {
  signal?: AbortSignal
  images?: LlmImage[]
}

export type LLMCallFn = (
  prompt: string,
  providerConfig: AiProviderConfig,
  options?: LlmCallOptions
) => Promise<LLMResponse>
