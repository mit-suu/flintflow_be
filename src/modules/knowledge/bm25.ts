/**
 * CHỈ DÙNG CHO EVAL — BM25 trong process cho ablation của `eval-knowledge.ts`.
 *
 * Production tìm từ khoá bằng Mongo `$text` (index `knowledge_chunks_text`, ngôn ngữ english). Ablation cần chấm cả
 * chunker không được lưu vào DB (fixed-size, heading-không-header) trên cùng một thước đo, nên cả 9 ô đều dùng BM25 này.
 * Gần với `$text` ở chỗ: chữ thường, bỏ stopword tiếng Anh, gộp vài hậu tố số nhiều / chia động từ thường gặp; khác ở
 * chỗ: không có trọng số field (`section` ×4 của index Mongo) và stemmer thô hơn Snowball — số của ô `lexical` là xấp xỉ.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have if in into is it its no not of on or such that the their then there " +
    "these they this to was were will with what which who when where why how do does did can could should would you your " +
    "i we our me my"
  ).split(" ")
)

/** Gộp hậu tố thô: `rules` → `rule`, `naming` → `name`, `raised` → `rais`. Chỉ cần nhất quán giữa câu hỏi và chunk. */
const stem = (w: string): string => {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -1)
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1)
  return w
}

export const tokenizeForBm25 = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t)).map(stem)

export interface Bm25Index {
  ids: string[]
  docTerms: Map<string, number>[]
  docLen: number[]
  avgLen: number
  df: Map<string, number>
}

export const buildBm25 = (docs: readonly { id: string; text: string }[]): Bm25Index => {
  const docTerms = docs.map((d) => {
    const tf = new Map<string, number>()
    for (const t of tokenizeForBm25(d.text)) tf.set(t, (tf.get(t) ?? 0) + 1)
    return tf
  })
  const docLen = docTerms.map((tf) => [...tf.values()].reduce((s, n) => s + n, 0))
  const df = new Map<string, number>()
  for (const tf of docTerms) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  return { ids: docs.map((d) => d.id), docTerms, docLen, avgLen: docLen.reduce((s, n) => s + n, 0) / Math.max(1, docs.length), df }
}

/** Top `limit` id theo điểm BM25 (k1 = 1,2, b = 0,75); điểm 0 bị bỏ — như `$text` chỉ trả document có khớp. */
export const searchBm25 = (index: Bm25Index, query: string, limit: number, k1 = 1.2, b = 0.75): { id: string; score: number }[] => {
  const terms = [...new Set(tokenizeForBm25(query))]
  const n = index.ids.length
  const scores = index.docTerms.map((tf, i) => {
    let score = 0
    for (const t of terms) {
      const f = tf.get(t)
      if (!f) continue
      const df = index.df.get(t) ?? 0
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.docLen[i]!) / (index.avgLen || 1)))
    }
    return { id: index.ids[i]!, score }
  })
  return scores
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id))
    .slice(0, limit)
}
