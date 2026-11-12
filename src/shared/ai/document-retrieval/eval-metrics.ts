/**
 * Đo chất lượng tìm đoạn tài liệu upload (FLF-393) — hàm thuần cho `npm run eval:doc-retrieval`.
 * Một câu hỏi "trúng" khi trong các chunk được chọn (đúng đường chọn của lượt chat: BM25 top-k + trần token) có chunk
 * chứa một trong các chuỗi `expect` (so không phân biệt hoa thường / dấu).
 */

import { rankChunks } from "./rank.js"
import type { ProjectChunkIndex } from "./chunk-index.service.js"
import { chunkCost, selectChunks } from "./select.js"
import { foldDiacritics } from "./vi-tokenizer.js"

export interface RetrievalQuestion {
  /** Câu hỏi như user gõ trong chat. */
  q: string
  /** Chuỗi phải có trong đoạn đúng — trúng khi có ít nhất một chuỗi. */
  expect: string[]
  /** Nhóm để báo cáo: `code` (hỏi theo mã), `screen`, `vi`, `vi_no_accent`… */
  kind?: string
}

export interface QuestionResult {
  q: string
  kind: string
  hit: boolean
  /** Hạng BM25 (1-based) của chunk đúng đầu tiên; `null` = không nằm trong danh sách ứng viên. */
  rank: number | null
  chunks: number
  tokens: number
}

export interface RetrievalReport {
  results: QuestionResult[]
  recall: number
  recallByKind: Record<string, { hit: number; total: number }>
  /** Token tài liệu trung bình mỗi câu hỏi sau khi chọn. */
  avgTokens: number
  maxTokens: number
}

const fold = (s: string): string => foldDiacritics(s.normalize("NFC")).toLowerCase()

export const evaluateRetrieval = (index: ProjectChunkIndex, questions: readonly RetrievalQuestion[], options: { topK: number; maxTokens: number; candidates?: number; codeWeight?: number }): RetrievalReport => {
  const textById = new Map(index.chunks.map((c) => [c.id, fold(`${c.titles.join("\n")}\n${c.paragraphs.join("\n")}`)]))
  const results: QuestionResult[] = questions.map((question) => {
    const ranked = rankChunks(index.bm25, question.q, options.candidates ?? 200, options.codeWeight)
    const selected = selectChunks({ chunks: index.chunks, ranked, maxTokens: options.maxTokens, topK: options.topK })
    const wanted = question.expect.map(fold)
    const matches = (id: string): boolean => wanted.some((w) => textById.get(id)!.includes(w))
    const rankIndex = ranked.findIndex((h) => matches(h.id))
    return {
      q: question.q,
      kind: question.kind ?? "other",
      hit: selected.some((c) => matches(c.id)),
      rank: rankIndex === -1 ? null : rankIndex + 1,
      chunks: selected.length,
      tokens: selected.reduce((sum, c) => sum + chunkCost(c), 0)
    }
  })

  const recallByKind: Record<string, { hit: number; total: number }> = {}
  for (const r of results) {
    const bucket = (recallByKind[r.kind] ??= { hit: 0, total: 0 })
    bucket.total++
    if (r.hit) bucket.hit++
  }
  const total = results.length || 1
  return {
    results,
    recall: results.filter((r) => r.hit).length / total,
    recallByKind,
    avgTokens: Math.round(results.reduce((sum, r) => sum + r.tokens, 0) / total),
    maxTokens: Math.max(0, ...results.map((r) => r.tokens))
  }
}
