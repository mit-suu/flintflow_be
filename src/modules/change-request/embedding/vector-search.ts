/**
 * Tìm phần tử Spine gần nghĩa với CR bằng Atlas Vector Search (`$vectorSearch`, index `spine_embeddings_vector`).
 * Mọi đường lỗi trả `[]` — C-3 khi đó tìm theo từ khoá như cũ:
 *   - embedding tắt / thiếu key ⇒ `[]`, không đụng DB;
 *   - Mongo không có `$vectorSearch` (Mongo in-memory, standalone, community không có mongot) ⇒ `[]`, **nhớ** kết quả
 *     cho cả process (thăm dò một lần, không gọi model embed query);
 *   - lỗi khác (mạng, provider) ⇒ log + `[]`, không nhớ (lần sau thử lại).
 * Kết quả chưa lọc theo Spine hiện tại — `findSpineLocations` bỏ path không còn (dòng index cũ chưa kịp dọn).
 * Không lọc `spine_version`: phần tử không đổi chữ giữ dòng cũ, lọc theo version sẽ làm mất chúng.
 */

import mongoose from "mongoose"
import { env } from "../../../config/env.js"
import { embeddingAvailable, embedTexts } from "../../../shared/ai/embedding/embedding.provider.js"
import type { VectorCandidate } from "../spine-location.js"
import { SPINE_EMBEDDING_INDEX, SpineEmbedding } from "./spine-embedding.model.js"

/** Mã lỗi Mongo khi không có `$vectorSearch`: stage lạ (40324), chỉ có trên Atlas (6047401), search chưa bật (31082). */
const UNSUPPORTED_CODES = new Set([40324, 6047401, 31082])
const UNSUPPORTED_MESSAGE = /Unrecognized pipeline stage|\$vectorSearch is not allowed|only (allowed|supported) (on|in) (MongoDB )?Atlas|SearchNotEnabled|search is not enabled/i

export const isVectorSearchUnsupported = (err: unknown): boolean => {
  const e = err as { code?: unknown; codeName?: unknown; message?: unknown } | null
  if (!e) return false
  if (typeof e.code === "number" && UNSUPPORTED_CODES.has(e.code)) return true
  return UNSUPPORTED_MESSAGE.test(`${String(e.codeName ?? "")} ${String(e.message ?? "")}`)
}

/** `null` = chưa thăm dò; nhớ cho cả process. */
let support: boolean | null = null

/** Test: quên kết quả thăm dò. */
export const resetVectorSearchSupport = (): void => {
  support = null
}

const vectorStage = (projectId: mongoose.Types.ObjectId, queryVector: number[], limit: number) => ({
  $vectorSearch: {
    index: SPINE_EMBEDDING_INDEX,
    path: "embedding",
    queryVector,
    numCandidates: Math.min(10_000, Math.max(limit * 10, 100)),
    limit,
    filter: { projectId, kind: "element" }
  }
})

/**
 * Mongo đang nối có chạy được `$vectorSearch` không — thăm dò bằng một truy vấn rỗng (vector đơn vị, project không tồn
 * tại), nhớ kết quả. Lỗi không phải "không hỗ trợ" ⇒ `false` lần này, không nhớ.
 */
export const isVectorSearchSupported = async (): Promise<boolean> => {
  if (support !== null) return support
  const probe = new Array<number>(env.EMBEDDING_DIMENSIONS).fill(0)
  probe[0] = 1
  try {
    await SpineEmbedding.aggregate([vectorStage(new mongoose.Types.ObjectId(), probe, 1) as never]).exec()
    support = true
  } catch (err) {
    if (isVectorSearchUnsupported(err)) {
      support = false
      console.warn("[C-3] Mongo không có $vectorSearch (không phải Atlas) — tìm vị trí CR theo từ khoá")
    } else {
      console.warn(`[C-3] thăm dò $vectorSearch lỗi: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
  return support
}

export interface VectorSearchOptions {
  limit?: number
  /** Điểm tối thiểu (`vectorSearchScore`, cosine chuẩn về 0..1). */
  minScore?: number
}

/** Top-K phần tử của project gần nghĩa với `queryText`, điểm ≥ `minScore`, giảm dần. */
export const vectorCandidates = async (projectId: string, queryText: string, options: VectorSearchOptions = {}): Promise<VectorCandidate[]> => {
  const limit = options.limit ?? env.CR_VECTOR_TOP_K
  const minScore = options.minScore ?? env.CR_VECTOR_MIN_SCORE
  if (!queryText.trim() || !embeddingAvailable() || !(await isVectorSearchSupported())) return []
  try {
    const [queryVector] = await embedTexts([queryText], { taskType: "RETRIEVAL_QUERY" })
    const rows = (await SpineEmbedding.aggregate([
      vectorStage(new mongoose.Types.ObjectId(projectId), queryVector!, limit) as never,
      { $project: { _id: 0, ref: 1, score: { $meta: "vectorSearchScore" } } }
    ]).exec()) as { ref: string; score: number }[]
    return rows.filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score)
  } catch (err) {
    if (isVectorSearchUnsupported(err)) support = false
    console.warn(`[C-3] tìm vị trí theo vector lỗi (project ${projectId}) — dùng từ khoá: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
