/**
 * Tầng tìm theo vector của Knowledge RAG (FLF-267), hai backend sau một giao diện:
 *   - `atlas`: `$vectorSearch` trên index `knowledge_chunks_vector`. Atlas trả `vectorSearchScore = (1 + cos) / 2` với
 *     similarity cosine ⇒ đổi về cosine trước khi so ngưỡng (`KNOWLEDGE_MIN_SCORE` là cosine);
 *   - `memory`: nạp embedding của corpus một lần (cache theo corpus, có hạn), cosine vét cạn. Dùng cho eval và làm dự
 *     phòng khi Mongo không có `$vectorSearch` (Mongo in-memory, standalone, community không mongot) mà dòng đã có vector.
 *
 * Nhận diện "Mongo không có `$vectorSearch`" chép cách làm của nhánh hybrid retrieval C-3 (`feat/cr-hybrid-retrieval`,
 * `change-request/embedding/vector-search.ts` — chưa merge nên không import được): mã 40324 (stage lạ), 6047401 (chỉ có
 * trên Atlas), 31082 (search chưa bật) hoặc thông điệp tương ứng; thăm dò một lần, nhớ cho cả process.
 */

import { env } from "../../config/env.js"
import { embeddingAvailable, embeddingModelId } from "../../shared/ai/embedding/embedding.provider.js"
import type { KnowledgeStatus } from "./chunker.js"
import { KNOWLEDGE_VECTOR_INDEX, KnowledgeChunk } from "./knowledge-chunk.model.js"

export type VectorBackendName = "atlas" | "memory"

export interface VectorFilter {
  corpus: readonly string[]
  statuses: readonly KnowledgeStatus[]
  /** Có ⇒ chỉ chunk có `applies_to` giao với danh sách này. */
  appliesTo?: readonly string[]
}

export interface VectorHit {
  chunk_id: string
  /** Cosine (−1..1). */
  cosine: number
}

export interface VectorBackend {
  name: VectorBackendName
  search(queryVector: readonly number[], filter: VectorFilter, limit: number): Promise<VectorHit[]>
}

// ─── nhận diện Mongo không có $vectorSearch ───────────────────────

const UNSUPPORTED_CODES = new Set([40324, 6047401, 31082])
const UNSUPPORTED_MESSAGE =
  /Unrecognized pipeline stage|\$vectorSearch is not allowed|\$listSearchIndexes|only (allowed|supported) (on|in) (MongoDB )?Atlas|SearchNotEnabled|search is not enabled|requires additional configuration|Search index commands are only supported/i

export const isVectorSearchUnsupported = (err: unknown): boolean => {
  const e = err as { code?: unknown; codeName?: unknown; message?: unknown } | null
  if (!e) return false
  if (typeof e.code === "number" && UNSUPPORTED_CODES.has(e.code)) return true
  return UNSUPPORTED_MESSAGE.test(`${String(e.codeName ?? "")} ${String(e.message ?? "")}`)
}

/** `cos = 2·score − 1` — score của Atlas với similarity cosine là `(1 + cos) / 2`. */
export const atlasScoreToCosine = (score: number): number => 2 * score - 1

export const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Bộ lọc metadata dạng Mongo — dùng chung cho `$vectorSearch.filter` và truy vấn `$text`. */
export const knowledgeMongoFilter = (filter: VectorFilter): Record<string, unknown> => ({
  corpus: { $in: [...filter.corpus] },
  status: { $in: [...filter.statuses] },
  ...(filter.appliesTo?.length ? { applies_to: { $in: [...filter.appliesTo] } } : {})
})

// ─── atlas ────────────────────────────────────────────────────────

const vectorStage = (queryVector: readonly number[], filter: VectorFilter, limit: number) => ({
  $vectorSearch: {
    index: KNOWLEDGE_VECTOR_INDEX,
    path: "embedding",
    queryVector: [...queryVector],
    numCandidates: Math.min(10_000, Math.max(limit * 10, 100)),
    limit,
    filter: knowledgeMongoFilter(filter)
  }
})

/** `null` = chưa thăm dò; nhớ cho cả process. */
let atlasSupport: boolean | null = null

/** Test: quên kết quả thăm dò. */
export const resetAtlasSupport = (): void => {
  atlasSupport = null
}

/** Mongo đang nối chạy được `$vectorSearch` không — thăm dò bằng truy vấn rỗng, nhớ kết quả. Lỗi khác ⇒ `false`, không nhớ. */
export const isAtlasVectorSearchSupported = async (): Promise<boolean> => {
  if (atlasSupport !== null) return atlasSupport
  const probe = new Array<number>(env.EMBEDDING_DIMENSIONS).fill(0)
  probe[0] = 1
  try {
    await KnowledgeChunk.aggregate([vectorStage(probe, { corpus: ["__probe__"], statuses: ["verified"] }, 1) as never]).exec()
    atlasSupport = true
  } catch (err) {
    if (isVectorSearchUnsupported(err)) {
      atlasSupport = false
      console.warn("[knowledge] Mongo không có $vectorSearch (không phải Atlas) — dùng backend vector trong bộ nhớ nếu có embedding")
    } else {
      console.warn(`[knowledge] thăm dò $vectorSearch lỗi: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
  return atlasSupport
}

export const atlasBackend: VectorBackend = {
  name: "atlas",
  async search(queryVector, filter, limit) {
    try {
      const rows = (await KnowledgeChunk.aggregate([
        vectorStage(queryVector, filter, limit) as never,
        { $project: { _id: 0, chunk_id: 1, score: { $meta: "vectorSearchScore" } } }
      ]).exec()) as { chunk_id: string; score: number }[]
      return rows.map((r) => ({ chunk_id: r.chunk_id, cosine: atlasScoreToCosine(r.score) })).sort((a, b) => b.cosine - a.cosine)
    } catch (err) {
      if (isVectorSearchUnsupported(err)) atlasSupport = false
      throw err
    }
  }
}

// ─── memory ───────────────────────────────────────────────────────

export interface MemoryRow {
  chunk_id: string
  corpus: string
  status: KnowledgeStatus
  applies_to: string[]
  embedding: number[]
}

/** Cache embedding theo corpus — hết hạn để instance khác ingest xong thì instance này cũng thấy (không có pub/sub). */
export const MEMORY_INDEX_TTL_MS = 5 * 60 * 1000
const memoryIndex = new Map<string, { loadedAt: number; model: string; rows: MemoryRow[] }>()

/** Ingest gọi sau khi ghi xong; test gọi để nạp lại. Không truyền corpus ⇒ xoá hết. */
export const invalidateMemoryIndex = (corpus?: string): void => {
  if (corpus === undefined) memoryIndex.clear()
  else memoryIndex.delete(corpus)
}

const loadMemoryRows = async (corpus: string): Promise<MemoryRow[]> => {
  const model = embeddingModelId()
  const cached = memoryIndex.get(corpus)
  if (cached && cached.model === model && Date.now() - cached.loadedAt < MEMORY_INDEX_TTL_MS) return cached.rows
  // Chỉ dòng embed bằng model hiện tại — vector của model khác không cùng không gian
  const rows = (await KnowledgeChunk.find(
    { corpus, model, "embedding.0": { $exists: true } },
    { _id: 0, chunk_id: 1, corpus: 1, status: 1, applies_to: 1, embedding: 1 }
  ).lean()) as MemoryRow[]
  memoryIndex.set(corpus, { loadedAt: Date.now(), model, rows })
  return rows
}

/** Lọc metadata + cosine vét cạn trên mảng dòng có sẵn — dùng chung cho backend memory và eval (index trong process). */
export const searchRows = (rows: readonly MemoryRow[], queryVector: readonly number[], filter: VectorFilter, limit: number): VectorHit[] => {
  const applies = filter.appliesTo?.length ? new Set(filter.appliesTo) : null
  return rows
    .filter((r) => filter.corpus.includes(r.corpus) && filter.statuses.includes(r.status) && (!applies || r.applies_to.some((s) => applies.has(s))))
    .map((r) => ({ chunk_id: r.chunk_id, cosine: cosine(queryVector, r.embedding) }))
    .sort((a, b) => b.cosine - a.cosine || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, limit)
}

export const memoryBackend: VectorBackend = {
  name: "memory",
  async search(queryVector, filter, limit) {
    const rows = (await Promise.all(filter.corpus.map(loadMemoryRows))).flat()
    return searchRows(rows, queryVector, filter, limit)
  }
}

/** Corpus có ít nhất một dòng mang vector của model hiện tại (để quyết có lùi về `memory` được không). */
const hasMemoryRows = async (corpus: readonly string[]): Promise<boolean> =>
  (await Promise.all(corpus.map(loadMemoryRows))).some((rows) => rows.length > 0)

/**
 * Backend vector dùng cho lượt này, hoặc `null` (không embedding ⇒ chỉ tìm từ khoá).
 * `KNOWLEDGE_VECTOR_BACKEND=atlas` mà Mongo không có `$vectorSearch` ⇒ lùi về `memory` nếu đã có vector.
 */
export const resolveVectorBackend = async (corpus: readonly string[]): Promise<VectorBackend | null> => {
  if (!embeddingAvailable()) return null
  if (env.KNOWLEDGE_VECTOR_BACKEND === "atlas" && (await isAtlasVectorSearchSupported())) return atlasBackend
  return (await hasMemoryRows(corpus)) ? memoryBackend : null
}
