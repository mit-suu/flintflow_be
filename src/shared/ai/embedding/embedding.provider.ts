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
  /**
   * Gặp 429 theo phút thì chờ rồi gọi lại — chỉ cho script chạy lô (ingest, backfill, eval). Mặc định tắt: lượt embed
   * nằm trong request của người dùng (câu hỏi chat, câu CR) phải hỏng nhanh để người gọi dùng đường từ khoá thay vì chờ.
   */
  waitOnRateLimit?: boolean
}

/** Số text tối đa mỗi lượt `batchEmbedContents` (giới hạn của Gemini là 100). */
export const EMBED_BATCH_SIZE = 100
/** Text dài hơn bị cắt — model nhận ~2048 token, vị trí CR chỉ cần phần đầu (tên + mô tả). */
export const EMBED_MAX_CHARS = 6000
/**
 * Trần ký tự mỗi lượt (~17k token): free tier còn trần token/phút — lô 100 text × ~512 token (~51k token) vượt trần, gọi
 * lại bao nhiêu lần cũng 429 (đo 2026-10-08: lô ~30k token qua, lô ~51k token hỏng mãi). Chia lô theo cả số text lẫn ký tự.
 */
export const EMBED_BATCH_MAX_CHARS = 60_000
/** Chờ trước lượt gọi lại khi lỗi tạm thời (429 / 5xx / timeout). */
export const EMBED_RETRY_BACKOFF_MS = [1000, 3000]
/**
 * `waitOnRateLimit`: 429 theo phút (free tier: 100 text/phút — mỗi text trong lô tính một lượt; còn trần token/phút) ⇒
 * chờ đúng thời gian Google báo ("retry in Ns"), không báo thì chờ `EMBED_RATE_LIMIT_DEFAULT_WAIT_MS`, rồi gọi lại, tối
 * đa `EMBED_RATE_LIMIT_RETRIES` lần. Chờ dài hơn `EMBED_RATE_LIMIT_MAX_WAIT_MS` (quota ngày) ⇒ ném ngay.
 */
export const EMBED_RATE_LIMIT_MAX_WAIT_MS = 65_000
export const EMBED_RATE_LIMIT_DEFAULT_WAIT_MS = 60_000
export const EMBED_RATE_LIMIT_RETRIES = 6

/** Thời gian chờ Google báo trong lỗi 429: `RetryInfo.retryDelay` ("25s") hoặc câu "Please retry in 25.59s". */
export const retryAfterMs = (data: unknown, message: string): number | null => {
  const details = (data as { error?: { details?: { retryDelay?: string }[] } } | undefined)?.error?.details ?? []
  const fromInfo = details.map((d) => /^(\d+(?:\.\d+)?)s$/.exec(d?.retryDelay ?? "")?.[1]).find(Boolean)
  const seconds = fromInfo ?? /retry in (\d+(?:\.\d+)?)\s*s/i.exec(message)?.[1]
  return seconds ? Math.ceil(Number(seconds) * 1000) : null
}

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
    const message = e.response?.data?.error?.message ?? e.message ?? "Gemini embedding lỗi"
    const wait = status === 429 ? retryAfterMs(e.response?.data, message) : null
    throw new AiActionError(status, message, status === 429 ? "RATE_LIMIT_EXCEEDED" : "EMBEDDING_ERROR", wait !== null ? { retryAfterMs: wait } : undefined)
  }
}

const withRetry = async <T>(fn: () => Promise<T>, waitOnRateLimit: boolean): Promise<T> => {
  let rateLimited = 0
  for (let attempt = 0; ; ) {
    try {
      return await fn()
    } catch (error) {
      // 429 theo phút: câu lỗi có "exceeded your current quota" nên `isTransientError` coi là hết tiền — xử lý riêng
      const wait =
        waitOnRateLimit && error instanceof AiActionError && error.code === "RATE_LIMIT_EXCEEDED"
          ? ((error.details?.retryAfterMs as number | undefined) ?? EMBED_RATE_LIMIT_DEFAULT_WAIT_MS)
          : undefined
      if (wait !== undefined && wait <= EMBED_RATE_LIMIT_MAX_WAIT_MS && rateLimited < EMBED_RATE_LIMIT_RETRIES) {
        rateLimited++
        await delay(wait + 500)
        continue
      }
      if (wait !== undefined) throw error
      if (attempt >= EMBED_RETRY_BACKOFF_MS.length || !isTransientError(error)) throw error
      await delay(EMBED_RETRY_BACKOFF_MS[attempt++]!)
    }
  }
}

/** Chia text thành lô liên tiếp ≤ `EMBED_BATCH_SIZE` text và ≤ `EMBED_BATCH_MAX_CHARS` ký tự (giữ thứ tự). */
export const embedBatches = (texts: readonly string[], maxCount = EMBED_BATCH_SIZE, maxChars = EMBED_BATCH_MAX_CHARS): string[][] => {
  const batches: string[][] = []
  let cur: string[] = []
  let chars = 0
  for (const t of texts) {
    if (cur.length && (cur.length >= maxCount || chars + t.length > maxChars)) {
      batches.push(cur)
      cur = []
      chars = 0
    }
    cur.push(t)
    chars += t.length
  }
  if (cur.length) batches.push(cur)
  return batches
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
  for (const batch of embedBatches(clipped)) {
    out.push(...(await withRetry(() => callGeminiBatch(batch, options.taskType), options.waitOnRateLimit ?? false)))
  }
  return out
}
