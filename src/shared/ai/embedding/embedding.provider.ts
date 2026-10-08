/**
 * Embedding văn bản cho C-3 tìm vị trí CR theo nghĩa (hybrid retrieval). Provider chọn bằng env, giống `callLLM`:
 *   - `EMBEDDING_PROVIDER=off` (mặc định) ⇒ không có embedding, C-3 tìm theo từ khoá như cũ;
 *   - `gemini` ⇒ `batchEmbedContents` của model `EMBEDDING_MODEL` (mặc định `gemini-embedding-001`, 768 chiều);
 *   - `mock` hoặc `AI_PROVIDER_OVERRIDE=mock` ⇒ túi từ băm tất định (`embedding.mock.ts`), không gọi mạng.
 * Embedding **không trừ credit** (chi phí rất nhỏ so với C-4 — chốt với nhóm, `docs/spec-gaps.md`).
 */

import axios from "axios"
import { env } from "../../../config/env.js"
import { AiActionError } from "../ai-action.types.js"
import { delay, isTransientError } from "../retry.service.js"
import { l2Normalize, mockEmbedding } from "./embedding.mock.js"

export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"
export type EmbeddingProviderName = "gemini" | "mock"

export interface EmbedOptions {
  taskType: EmbeddingTaskType
}

/** Số text tối đa mỗi lượt `batchEmbedContents` (giới hạn của Gemini là 100). */
export const EMBED_BATCH_SIZE = 100
/** Text dài hơn bị cắt — model nhận ~2048 token, vị trí CR chỉ cần phần đầu (tên + mô tả). */
export const EMBED_MAX_CHARS = 6000
/** Chờ trước lượt gọi lại khi lỗi tạm thời (429 / 5xx / timeout). */
export const EMBED_RETRY_BACKOFF_MS = [1000, 3000]

/** Provider đang bật, hoặc `null` khi embedding không dùng được (tắt / thiếu key). */
export const embeddingProvider = (): EmbeddingProviderName | null => {
  if (env.EMBEDDING_PROVIDER === "off") return null
  if (env.AI_PROVIDER_OVERRIDE.trim().toLowerCase() === "mock" || env.EMBEDDING_PROVIDER === "mock") return "mock"
  return env.GEMINI_API_KEY ? "gemini" : null
}

export const embeddingAvailable = (): boolean => embeddingProvider() !== null

/** Model ghi kèm mỗi dòng index — đổi model/số chiều thì mọi dòng cũ bị coi là lệch và embed lại. */
export const embeddingModelId = (): string =>
  embeddingProvider() === "mock" ? `mock-bow-${env.EMBEDDING_DIMENSIONS}` : `${env.EMBEDDING_MODEL}@${env.EMBEDDING_DIMENSIONS}`

const callGeminiBatch = async (texts: readonly string[], taskType: EmbeddingTaskType): Promise<number[][]> => {
  const model = env.EMBEDDING_MODEL
  try {
    const response = await axios.post(
      `${env.EMBEDDING_API_BASE_URL}/models/${model}:batchEmbedContents`,
      {
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: env.EMBEDDING_DIMENSIONS
        }))
      },
      // Key đi qua header (không nằm trong URL ⇒ không lọt vào log lỗi của axios)
      { headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, timeout: env.EMBEDDING_TIMEOUT_MS }
    )
    const embeddings = (response.data?.embeddings ?? []) as { values?: number[] }[]
    if (embeddings.length !== texts.length || embeddings.some((e) => !Array.isArray(e.values) || e.values.length !== env.EMBEDDING_DIMENSIONS)) {
      throw new AiActionError(502, `Gemini embedding trả ${embeddings.length}/${texts.length} vector không đúng ${env.EMBEDDING_DIMENSIONS} chiều`, "EMBEDDING_BAD_RESPONSE")
    }
    // Số chiều < 3072 (MRL cắt bớt) thì Gemini không chuẩn hoá sẵn — cosine không đổi nhưng giữ vector đơn vị cho chắc
    return embeddings.map((e) => l2Normalize(e.values!))
  } catch (error: unknown) {
    if (error instanceof AiActionError) throw error
    const e = error as { code?: string; message?: string; response?: { status?: number; data?: { error?: { message?: string } } } }
    if (!e.response && (e.code === "ECONNABORTED" || e.code === "ETIMEDOUT")) {
      throw new AiActionError(504, `Gemini embedding không trả lời kịp (${e.message ?? ""})`, "EMBEDDING_TIMEOUT")
    }
    const status = e.response?.status ?? 500
    throw new AiActionError(status, e.response?.data?.error?.message ?? e.message ?? "Gemini embedding lỗi", status === 429 ? "RATE_LIMIT_EXCEEDED" : "EMBEDDING_ERROR")
  }
}

const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= EMBED_RETRY_BACKOFF_MS.length || !isTransientError(error)) throw error
      await delay(EMBED_RETRY_BACKOFF_MS[attempt]!)
    }
  }
}

/**
 * Embed nhiều text, giữ thứ tự. Chia lô `EMBED_BATCH_SIZE`, mỗi lô gọi lại tối đa 2 lần khi lỗi tạm thời.
 * Embedding không dùng được ⇒ `EMBEDDING_UNAVAILABLE` (người gọi nên kiểm `embeddingAvailable()` trước).
 */
export const embedTexts = async (texts: readonly string[], options: EmbedOptions): Promise<number[][]> => {
  const provider = embeddingProvider()
  if (!provider) throw new AiActionError(503, "Embedding chưa được bật hoặc thiếu API key", "EMBEDDING_UNAVAILABLE")
  const clipped = texts.map((t) => t.slice(0, EMBED_MAX_CHARS))
  if (provider === "mock") return clipped.map((t) => mockEmbedding(t, env.EMBEDDING_DIMENSIONS))
  const out: number[][] = []
  for (let i = 0; i < clipped.length; i += EMBED_BATCH_SIZE) {
    const batch = clipped.slice(i, i + EMBED_BATCH_SIZE)
    out.push(...(await withRetry(() => callGeminiBatch(batch, options.taskType))))
  }
  return out
}
