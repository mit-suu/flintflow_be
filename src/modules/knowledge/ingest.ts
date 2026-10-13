/**
 * Ingest một corpus tri thức vào `knowledge_chunks` (FLF-267):
 *   chunk → so `text_hash` với dòng đang có của corpus → chỉ embed chunk mới/đổi (`RETRIEVAL_DOCUMENT`, theo lô
 *   `embedTexts`) → upsert mọi chunk (metadata như `status`, `applies_to` cập nhật cả khi chữ không đổi) → xoá dòng của
 *   corpus có `chunk_id` không còn.
 * Embedding không trừ credit (như C-3). Embedding không dùng được ⇒ từ chối chạy, không ghi gì.
 */

import crypto from "node:crypto"
import { AiActionError } from "../../shared/ai/ai-action.types.js"
import { embeddingAvailable, embeddingModelId, embedTexts } from "../../shared/ai/embedding/embedding.provider.js"
import { estimateTokens, type KnowledgeChunkDraft } from "./chunker.js"
import { KnowledgeChunk } from "./knowledge-chunk.model.js"
import { invalidateMemoryIndex } from "./vector-backend.js"

export const textHash = (modelId: string, embedText: string): string =>
  crypto.createHash("sha256").update(`${modelId}\n${embedText}`).digest("hex")

export interface IngestSummary {
  corpus: string
  model: string
  chunks: number
  embedded: number
  unchanged: number
  deleted: number
  /** Token ước lượng của `embed_text` đã gửi đi embed. */
  embedded_tokens: number
  /** Token ước lượng của `text` cả corpus. */
  tokens: number
}

export interface IngestOptions {
  corpus: string
  /** Mặc định `embedTexts(…, RETRIEVAL_DOCUMENT)` — test thay được. */
  embed?: (texts: string[]) => Promise<number[][]>
  modelId?: string
}

/** Chunk phải cùng `corpus` với lượt ingest — trộn corpus thì bước xoá sẽ xoá nhầm. */
export const ingestChunks = async (chunks: readonly KnowledgeChunkDraft[], options: IngestOptions): Promise<IngestSummary> => {
  const { corpus } = options
  const foreign = chunks.find((c) => c.corpus !== corpus)
  if (foreign) throw new Error(`Chunk ${foreign.chunk_id} thuộc corpus "${foreign.corpus}", không phải "${corpus}"`)
  if (!options.embed && !embeddingAvailable()) {
    throw new AiActionError(503, "Embedding chưa bật (EMBEDDING_PROVIDER=off hoặc thiếu GEMINI_API_KEY) — không ingest được tri thức", "EMBEDDING_UNAVAILABLE")
  }
  const modelId = options.modelId ?? embeddingModelId()
  // Ingest là script chạy lô ⇒ chờ hết rate limit theo phút thay vì hỏng giữa chừng
  const embed = options.embed ?? ((texts: string[]) => embedTexts(texts, { taskType: "RETRIEVAL_DOCUMENT", waitOnRateLimit: true }))

  const existing = await KnowledgeChunk.find({ corpus }, { chunk_id: 1, text_hash: 1, _id: 0 }).lean()
  const hashById = new Map(existing.map((r) => [r.chunk_id, r.text_hash]))
  const withHash = chunks.map((c) => ({ chunk: c, hash: textHash(modelId, c.embed_text) }))
  const changed = withHash.filter(({ chunk, hash }) => hashById.get(chunk.chunk_id) !== hash)

  const vectors = changed.length ? await embed(changed.map(({ chunk }) => chunk.embed_text)) : []
  if (vectors.length !== changed.length) throw new Error(`Embed trả ${vectors.length}/${changed.length} vector`)
  const vectorById = new Map(changed.map(({ chunk }, i) => [chunk.chunk_id, vectors[i]!]))

  if (withHash.length) {
    await KnowledgeChunk.bulkWrite(
      withHash.map(({ chunk, hash }) => {
        const { span: _span, merged: _merged, split: _split, ...fields } = chunk
        const vector = vectorById.get(chunk.chunk_id)
        return {
          updateOne: {
            filter: { chunk_id: chunk.chunk_id },
            update: { $set: { ...fields, text_hash: hash, model: modelId, ...(vector ? { embedding: vector } : {}) } },
            upsert: true
          }
        }
      }),
      { ordered: false }
    )
  }
  const keep = chunks.map((c) => c.chunk_id)
  const removed = await KnowledgeChunk.deleteMany({ corpus, chunk_id: { $nin: keep } })
  invalidateMemoryIndex(corpus)

  return {
    corpus,
    model: modelId,
    chunks: chunks.length,
    embedded: changed.length,
    unchanged: chunks.length - changed.length,
    deleted: removed.deletedCount ?? 0,
    embedded_tokens: changed.reduce((s, { chunk }) => s + estimateTokens(chunk.embed_text), 0),
    tokens: chunks.reduce((s, c) => s + c.tokens, 0)
  }
}
