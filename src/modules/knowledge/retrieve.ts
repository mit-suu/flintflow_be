/**
 * Truy hồi tri thức (FLF-267): lọc metadata → tìm vector (`vector-backend.ts`) + tìm từ khoá (Mongo `$text`) → gộp bằng
 * Reciprocal Rank Fusion → top-K → mở rộng small-to-big.
 *
 * - Lọc trước: `corpus`, `status = verified` (trừ khi `includePlaceholder`), `applies_to` giao với `appliesTo` nếu có.
 *   Chunk `placeholder` (chưa xác minh) không bao giờ tới prompt trả lời — answer.service không bật `includePlaceholder`.
 * - RRF: `rrf = Σ 1 / (RRF_K + rank)` trên danh sách vector và danh sách từ khoá (rank từ 1). `RRF_K = 60` là hằng số
 *   của bài báo gốc (Cormack et al., 2009): đủ lớn để một hạng đầu ở MỘT danh sách không lấn át chunk đứng khá ở cả hai.
 *   Gộp theo hạng nên không phải chuẩn hoá hai thang điểm khác nhau (cosine vs textScore).
 * - Tín hiệu từ chối: cosine của chunk gần nhất < `KNOWLEDGE_MIN_SCORE` ⇒ người gọi trả "không đủ căn cứ". Không có
 *   vector (embedding tắt / chưa ingest vector) ⇒ chỉ từ khoá: từ chối khi không có kết quả, hoặc chunk tốt nhất chứa
 *   chưa tới `LEXICAL_MIN_COVERAGE` số từ của câu hỏi — `$text` khớp chỉ cần MỘT từ, nên câu ngoài kho ("BABOK
 *   knowledge areas") vẫn kéo về chunk lạc đề nhờ một từ chung ("areas").
 * - Small-to-big: chunk là một phần của section bị cắt và cả section ≤ `PARENT_EXPAND_MAX_TOKENS` ⇒ `context_text` là
 *   cả section; còn lại `context_text = text`.
 */

import { env } from "../../config/env.js"
import { embedTexts } from "../../shared/ai/embedding/embedding.provider.js"
import { estimateTokens, type KnowledgeSourceKind, type KnowledgeStatus } from "./chunker.js"
import { KnowledgeChunk } from "./knowledge-chunk.model.js"
import { atlasBackend, memoryBackend, isVectorSearchUnsupported, knowledgeMongoFilter, resolveVectorBackend, type VectorBackend, type VectorFilter, type VectorHit } from "./vector-backend.js"

/** Hằng số k của Reciprocal Rank Fusion. */
export const RRF_K = 60
/** Số ứng viên mỗi danh sách trước khi gộp. */
export const DEFAULT_CANDIDATES = 20
/** Chỉ từ khoá: chunk tốt nhất phải chứa ít nhất ngần này phần từ của câu hỏi, không thì từ chối. */
export const LEXICAL_MIN_COVERAGE = 0.5
/** Section cha ≤ ngần này token thì chunk được mở rộng thành cả section. */
export const PARENT_EXPAND_MAX_TOKENS = 900

export type RetrievalMode = "hybrid" | "vector" | "lexical"
export type RetrievalBackend = "atlas" | "memory" | "lexical-only"

export interface RetrieveOptions {
  corpus: string | readonly string[]
  topK?: number
  candidates?: number
  appliesTo?: string | readonly string[]
  includePlaceholder?: boolean
  mode?: RetrievalMode
  /** Ngưỡng cosine để từ chối; mặc định `env.KNOWLEDGE_MIN_SCORE`. */
  minScore?: number
}

export interface RetrievedChunk {
  chunk_id: string
  source: string
  source_kind: KnowledgeSourceKind
  section: string
  status: KnowledgeStatus
  text: string
  /** Chữ đưa vào prompt — đã mở rộng small-to-big khi được. */
  context_text: string
  /** Cosine với câu hỏi (có khi chunk nằm trong danh sách vector). */
  vector_score?: number
  vector_rank?: number
  lexical_rank?: number
  rrf: number
}

export interface RetrievalResult {
  chunks: RetrievedChunk[]
  /** Cosine của chunk gần nhất theo vector; `null` khi không tìm vector. */
  top_vector_score: number | null
  backend: RetrievalBackend
  /** `true` ⇒ không đủ căn cứ, người gọi không được gọi model. */
  abstain: boolean
}

// ─── hàm thuần ────────────────────────────────────────────────────

export interface FusedHit {
  chunk_id: string
  rrf: number
  vector_rank?: number
  lexical_rank?: number
  vector_score?: number
}

/**
 * Gộp hai danh sách đã xếp hạng bằng RRF. Bằng điểm ⇒ chunk có hạng vector tốt hơn, rồi theo id (tất định).
 * Danh sách rỗng đóng góp 0 — chỉ một danh sách thì thứ tự giữ nguyên.
 */
/**
 * `lexicalWeight` nhân phần đóng góp của danh sách từ khoá (RRF có trọng số). 1 = RRF chuẩn; 0 = chỉ thứ tự vector (từ
 * khoá vẫn thêm ứng viên ở cuối, không đẩy ai xuống). Mặc định lấy từ `KNOWLEDGE_LEXICAL_WEIGHT`, chọn bằng eval.
 * Không có danh sách vector (chỉ từ khoá) ⇒ trọng số luôn là 1: thứ tự từ khoá là tất cả những gì có.
 */
export const rrfFuse = (vector: readonly VectorHit[], lexical: readonly string[], k = RRF_K, lexicalWeight = env.KNOWLEDGE_LEXICAL_WEIGHT): FusedHit[] => {
  const weight = vector.length ? lexicalWeight : 1
  const byId = new Map<string, FusedHit>()
  const hit = (id: string): FusedHit => {
    let h = byId.get(id)
    if (!h) {
      h = { chunk_id: id, rrf: 0 }
      byId.set(id, h)
    }
    return h
  }
  vector.forEach((v, i) => {
    const h = hit(v.chunk_id)
    if (h.vector_rank !== undefined) return
    h.vector_rank = i + 1
    h.vector_score = v.cosine
    h.rrf += 1 / (k + i + 1)
  })
  lexical.forEach((id, i) => {
    const h = hit(id)
    if (h.lexical_rank !== undefined) return
    h.lexical_rank = i + 1
    h.rrf += weight / (k + i + 1)
  })
  return [...byId.values()].sort(
    (a, b) =>
      b.rrf - a.rrf ||
      (a.vector_rank ?? Infinity) - (b.vector_rank ?? Infinity) ||
      (a.lexical_rank ?? Infinity) - (b.lexical_rank ?? Infinity) ||
      a.chunk_id.localeCompare(b.chunk_id)
  )
}

/**
 * Có vector ⇒ từ chối khi cosine cao nhất dưới ngưỡng. Chỉ từ khoá ⇒ từ chối khi không có kết quả, hoặc (khi truyền
 * `lexicalCoverage`) chunk tốt nhất phủ chưa tới `LEXICAL_MIN_COVERAGE` từ của câu hỏi.
 */
export const shouldAbstain = (topVectorScore: number | null, hasVector: boolean, lexicalHits: number, minScore: number, lexicalCoverage?: number): boolean =>
  hasVector
    ? topVectorScore === null || topVectorScore < minScore
    : lexicalHits === 0 || (lexicalCoverage !== undefined && lexicalCoverage < LEXICAL_MIN_COVERAGE)

/** Từ hư không mang nghĩa — bỏ khi đo độ phủ (tiếng Anh + tiếng Việt thường gặp trong câu hỏi). */
const STOPWORDS = new Set(
  [
    "the and for are what which when where how does that this with from into about there their have has was were will can should must not any all its",
    "là của và các những cho khi thì có không được một này đó như với trong theo nào gì bao nhiêu sao vậy"
  ]
    .join(" ")
    .split(" ")
)

/** Từ có nghĩa của câu hỏi: chữ thường, ≥ 3 ký tự, bỏ từ hư. */
export const queryTerms = (query: string): string[] => [
  ...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))
]

/**
 * Tỉ lệ từ của câu hỏi có trong chữ chunk. Từ dài khớp theo 5 ký tự đầu (thay cho stemming của `$text`: "rules" ⇔ "rule";
 * "naming" ⇔ "name" thì không — chấp nhận, đây chỉ là chặn câu lạc đề). Câu không có từ nào ⇒ 1.
 */
export const lexicalCoverage = (query: string, text: string): number => {
  const terms = queryTerms(query)
  if (!terms.length) return 1
  const hay = text.toLowerCase()
  return terms.filter((t) => hay.includes(t.length > 5 ? t.slice(0, 5) : t)).length / terms.length
}

export interface SiblingChunk {
  chunk_id: string
  part: number
  text: string
}

/** Small-to-big: cả section cha khi nó có ≥ 2 phần và tổng ≤ `maxTokens`; còn lại chữ của chính chunk. */
export const expandToParent = (chunk: { text: string }, siblings: readonly SiblingChunk[], maxTokens = PARENT_EXPAND_MAX_TOKENS): string => {
  if (siblings.length < 2) return chunk.text
  const ordered = [...siblings].sort((a, b) => a.part - b.part)
  const joined = ordered.map((s) => s.text).join("\n\n")
  return estimateTokens(joined) <= maxTokens ? joined : chunk.text
}

export const statusesFor = (includePlaceholder: boolean): KnowledgeStatus[] => (includePlaceholder ? ["verified", "placeholder"] : ["verified"])

const toArray = (v: string | readonly string[] | undefined): string[] => (v === undefined ? [] : typeof v === "string" ? [v] : [...v])

export const buildFilter = (options: RetrieveOptions): VectorFilter => {
  const appliesTo = toArray(options.appliesTo)
  return {
    corpus: toArray(options.corpus),
    statuses: statusesFor(options.includePlaceholder ?? false),
    ...(appliesTo.length ? { appliesTo } : {})
  }
}

// ─── truy vấn ─────────────────────────────────────────────────────

/** Từ khoá: Mongo `$text` (index `knowledge_chunks_text`), xếp theo `textScore`. */
export const lexicalSearch = async (query: string, filter: VectorFilter, limit: number): Promise<string[]> => {
  if (!query.trim()) return []
  const rows = await KnowledgeChunk.find({ $text: { $search: query }, ...knowledgeMongoFilter(filter) }, { _id: 0, chunk_id: 1, score: { $meta: "textScore" } })
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .lean()
  return rows.map((r) => r.chunk_id)
}

/** Tìm vector; Atlas báo không hỗ trợ giữa chừng ⇒ thử lại bằng `memory`. Lỗi khác ⇒ log, coi như không có vector. */
const vectorSearch = async (backend: VectorBackend, query: string, filter: VectorFilter, limit: number): Promise<{ backend: VectorBackend | null; hits: VectorHit[] }> => {
  let queryVector: number[]
  try {
    ;[queryVector] = (await embedTexts([query], { taskType: "RETRIEVAL_QUERY" })) as [number[]]
  } catch (err) {
    console.warn(`[knowledge] embed câu hỏi lỗi — chỉ tìm từ khoá: ${err instanceof Error ? err.message : String(err)}`)
    return { backend: null, hits: [] }
  }
  try {
    return { backend, hits: await backend.search(queryVector, filter, limit) }
  } catch (err) {
    if (backend === atlasBackend && isVectorSearchUnsupported(err)) return { backend: memoryBackend, hits: await memoryBackend.search(queryVector, filter, limit) }
    console.warn(`[knowledge] tìm vector lỗi — chỉ tìm từ khoá: ${err instanceof Error ? err.message : String(err)}`)
    return { backend: null, hits: [] }
  }
}

export const retrieveKnowledge = async (query: string, options: RetrieveOptions): Promise<RetrievalResult> => {
  const mode = options.mode ?? "hybrid"
  const topK = options.topK ?? env.KNOWLEDGE_TOP_K
  const candidates = Math.max(options.candidates ?? DEFAULT_CANDIDATES, topK)
  const minScore = options.minScore ?? env.KNOWLEDGE_MIN_SCORE
  const filter = buildFilter(options)

  let backend: VectorBackend | null = null
  let vectorHits: VectorHit[] = []
  if (mode !== "lexical" && query.trim()) {
    const resolved = await resolveVectorBackend(filter.corpus)
    if (resolved) ({ backend, hits: vectorHits } = await vectorSearch(resolved, query, filter, candidates))
  }
  // Chế độ `vector` mà không có vector ⇒ vẫn trả lời được bằng từ khoá thay vì im lặng
  const lexicalIds = mode === "vector" && backend ? [] : await lexicalSearch(query, filter, candidates)
  const fused = rrfFuse(mode === "lexical" ? [] : vectorHits, lexicalIds).slice(0, topK)
  const topVectorScore = vectorHits.length ? vectorHits[0]!.cosine : null

  const ids = fused.map((f) => f.chunk_id)
  const rows = ids.length
    ? await KnowledgeChunk.find({ chunk_id: { $in: ids } }, { _id: 0, chunk_id: 1, source: 1, source_kind: 1, section: 1, status: 1, text: 1, parent_id: 1, part: 1 }).lean()
    : []
  const rowById = new Map(rows.map((r) => [r.chunk_id, r]))
  const parents = [...new Set(rows.map((r) => r.parent_id))]
  const siblings = parents.length ? await KnowledgeChunk.find({ parent_id: { $in: parents } }, { _id: 0, chunk_id: 1, parent_id: 1, part: 1, text: 1 }).lean() : []
  const siblingsByParent = new Map<string, SiblingChunk[]>()
  for (const s of siblings) {
    if (!siblingsByParent.has(s.parent_id)) siblingsByParent.set(s.parent_id, [])
    siblingsByParent.get(s.parent_id)!.push(s)
  }

  const chunks: RetrievedChunk[] = fused.flatMap((f) => {
    const row = rowById.get(f.chunk_id)
    if (!row) return []
    return [
      {
        chunk_id: row.chunk_id,
        source: row.source,
        source_kind: row.source_kind,
        section: row.section,
        status: row.status,
        text: row.text,
        context_text: expandToParent(row, siblingsByParent.get(row.parent_id) ?? []),
        ...(f.vector_score !== undefined ? { vector_score: f.vector_score } : {}),
        ...(f.vector_rank !== undefined ? { vector_rank: f.vector_rank } : {}),
        ...(f.lexical_rank !== undefined ? { lexical_rank: f.lexical_rank } : {}),
        rrf: f.rrf
      }
    ]
  })

  return {
    chunks,
    top_vector_score: topVectorScore,
    backend: backend ? backend.name : "lexical-only",
    // Backend vector không trả gì (index Atlas đang dựng / chưa ingest vector) ⇒ xét như chỉ có từ khoá
    abstain:
      shouldAbstain(topVectorScore, vectorHits.length > 0, lexicalIds.length, minScore, Math.max(0, ...chunks.map((c) => lexicalCoverage(query, c.text)))) ||
      chunks.length === 0
  }
}
