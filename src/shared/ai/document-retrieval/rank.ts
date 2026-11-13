/**
 * Xếp hạng chunk theo câu hỏi (FLF-393) — một chỗ dùng chung cho `document-context.service.ts` và eval.
 *
 * Mã trong câu hỏi (`UC-05`, `BR-02`, `SCR-03`…) được nhân trọng số: SRS dày định danh chính xác và người hỏi nhắc mã là
 * biết chắc mình cần đoạn nào. Không nhân thì câu hỏi tự nhiên dài ("cho mình biết UC-05 là use case gì… kèm mã đoạn
 * nguồn") bị các từ phổ biến trong tài liệu ("use case", "tài liệu", "nguồn") làm loãng — demo 2026-11-12 trên SRS
 * 3.870 đoạn: đoạn đúng của UC-05 / BR-02 rơi xuống hạng 16 / 31, ngoài top-k.
 */

import { searchBm25, type Bm25Hit, type Bm25Index } from "./bm25.js"
import { tokenizeText } from "./vi-tokenizer.js"
import { expandCrossLanguage } from "./vi-en-terms.js"

/** Hệ số nhân điểm của token mã trong câu hỏi. */
export const CODE_WEIGHT = 4

export const rankChunks = (index: Bm25Index, query: string, limit: number, codeWeight = CODE_WEIGHT): Bm25Hit[] => {
  // Câu hỏi tiếng Việt trên tài liệu tiếng Anh (và ngược lại): thêm thuật ngữ tương ứng của ngôn ngữ kia
  const { tokens, codes } = tokenizeText(expandCrossLanguage(query))
  if (!tokens.length) return []
  return searchBm25(index, tokens, limit, { weights: new Map(codes.map((c) => [c, codeWeight])) })
}
