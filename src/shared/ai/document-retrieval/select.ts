/**
 * Chọn chunk đưa vào prompt (FLF-393) — hàm thuần.
 *
 * Hai nguồn ứng viên:
 * - **Ghim** (tất định): chunk có tiêu đề khớp section mà step nuôi (`pinnedChunkIds`) — SRS có cấu trúc nên ánh xạ theo
 *   tiêu đề chính xác hơn tìm kiếm.
 * - **BM25**: top-k theo câu hỏi.
 * Ghim đi trước (ghim nhiều hơn ngân sách thì chunk được BM25 chấm cao hơn vào trước), BM25 lấp phần còn lại. Luôn dừng ở
 * trần token cứng; kết quả trả về theo thứ tự tài liệu để model đọc liền mạch.
 */

import { splitHeadingNumber, titleSimilarity } from "../../../modules/import/text-similarity.js"
import type { Bm25Hit } from "./bm25.js"
import type { DocumentChunk } from "./chunker.js"

/** Dòng nhãn `[Nguồn: … | mục: … ]` của mỗi chunk trong prompt. */
export const CHUNK_LABEL_TOKENS = 40

/** Tiêu đề chunk giống tiêu đề section từ mức này (Dice trên token đã gập dấu) thì coi là cùng mục. */
export const SECTION_TITLE_MATCH = 0.75

export interface SelectableChunk extends DocumentChunk {
  /** Khoá duy nhất trong index của project. */
  id: string
}

/** Chunk có tiêu đề (đã bỏ số mục) khớp một trong `sectionTitles`, theo thứ tự tài liệu. */
export const pinnedChunkIds = (chunks: readonly SelectableChunk[], sectionTitles: readonly string[], threshold = SECTION_TITLE_MATCH): string[] => {
  const wanted = sectionTitles.map((t) => t.trim()).filter(Boolean)
  if (!wanted.length) return []
  return chunks
    .filter((c) => c.titles.some((title) => wanted.some((w) => titleSimilarity(splitHeadingNumber(title).title, w) >= threshold)))
    .map((c) => c.id)
}

export interface SelectInput<T extends SelectableChunk> {
  /** Mọi chunk, theo thứ tự tài liệu. */
  chunks: readonly T[]
  /** Kết quả BM25, điểm giảm dần. */
  ranked: readonly Bm25Hit[]
  pinnedIds?: readonly string[]
  maxTokens: number
  /** Số chunk BM25 tối đa (không tính chunk ghim). */
  topK: number
}

export const chunkCost = (chunk: DocumentChunk): number => chunk.tokens + CHUNK_LABEL_TOKENS

export const selectChunks = <T extends SelectableChunk>({ chunks, ranked, pinnedIds = [], maxTokens, topK }: SelectInput<T>): T[] => {
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const order = new Map(chunks.map((c, i) => [c.id, i]))
  const score = new Map(ranked.map((h) => [h.id, h.score]))
  const pinned = new Set(pinnedIds.filter((id) => byId.has(id)))

  const pinnedOrder = [...pinned].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || order.get(a)! - order.get(b)!)
  const rankedOrder = ranked
    .map((h) => h.id)
    .filter((id) => byId.has(id) && !pinned.has(id))
    .slice(0, Math.max(0, topK))

  const picked = new Set<string>()
  let used = 0
  for (const id of [...pinnedOrder, ...rankedOrder]) {
    const cost = chunkCost(byId.get(id)!)
    // Chunk không vừa thì bỏ qua và thử chunk kế (nhỏ hơn có thể vừa) — không bao giờ vượt trần
    if (used + cost > maxTokens) continue
    picked.add(id)
    used += cost
  }
  return chunks.filter((c) => picked.has(c.id))
}

/** Các chunk đầu tài liệu vừa trong `maxTokens` — lối cuối khi không tìm được gì và không có tóm tắt. */
export const headChunks = <T extends SelectableChunk>(chunks: readonly T[], maxTokens: number): T[] => {
  const out: T[] = []
  let used = 0
  for (const c of chunks) {
    const cost = chunkCost(c)
    if (used + cost > maxTokens) break
    out.push(c)
    used += cost
  }
  return out
}
