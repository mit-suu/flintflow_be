/**
 * BM25 trong process (FLF-393) — hàm thuần, tokenizer truyền từ ngoài. Tất định: cùng index + cùng câu hỏi ra cùng thứ
 * tự (bằng điểm ⇒ theo thứ tự nạp), nên giải thích được vì sao một đoạn được chọn.
 *
 * `modules/knowledge/bm25.ts` là bản chỉ dùng cho eval của Knowledge RAG (tokenizer tiếng Anh gắn cứng) — không dùng lại
 * ở đây vì tài liệu upload cần tokenizer tiếng Việt và giữ mã `UC-12`.
 */

export interface Bm25Index {
  ids: string[]
  /** Tần suất token của từng tài liệu, cùng thứ tự với `ids`. */
  docTerms: Map<string, number>[]
  docLen: number[]
  avgLen: number
  /** Số tài liệu chứa token. */
  df: Map<string, number>
}

export interface Bm25Hit {
  id: string
  score: number
}

export const buildBm25 = (docs: readonly { id: string; text: string }[], tokenize: (text: string) => string[]): Bm25Index => {
  const docTerms = docs.map((d) => {
    const tf = new Map<string, number>()
    for (const t of tokenize(d.text)) tf.set(t, (tf.get(t) ?? 0) + 1)
    return tf
  })
  const docLen = docTerms.map((tf) => [...tf.values()].reduce((sum, n) => sum + n, 0))
  const df = new Map<string, number>()
  for (const tf of docTerms) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  return { ids: docs.map((d) => d.id), docTerms, docLen, avgLen: docLen.reduce((sum, n) => sum + n, 0) / Math.max(1, docs.length), df }
}

/** Top `limit` theo điểm BM25 (k1 = 1,2; b = 0,75). Điểm 0 (không trùng token nào) bị bỏ. */
export const searchBm25 = (index: Bm25Index, queryTokens: readonly string[], limit: number, k1 = 1.2, b = 0.75): Bm25Hit[] => {
  const terms = [...new Set(queryTokens)]
  const n = index.ids.length
  const hits: (Bm25Hit & { order: number })[] = []
  index.docTerms.forEach((tf, i) => {
    let score = 0
    for (const t of terms) {
      const f = tf.get(t)
      if (!f) continue
      const df = index.df.get(t) ?? 0
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.docLen[i]!) / (index.avgLen || 1)))
    }
    if (score > 0) hits.push({ id: index.ids[i]!, score, order: i })
  })
  return hits
    .sort((x, y) => y.score - x.score || x.order - y.order)
    .slice(0, Math.max(0, limit))
    .map(({ id, score }) => ({ id, score }))
}
