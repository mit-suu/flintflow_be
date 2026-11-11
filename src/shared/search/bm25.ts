/**
 * FLF-375 — BM25 (Okapi) cho tìm kiếm / truy xuất trong CR: xếp hạng văn bản theo từ khoá — từ hiếm nặng hơn từ phổ biến,
 * chuẩn hoá theo độ dài văn bản. Thuần, đồng bộ, tất định (test không cần DB / model).
 *
 * Tách từ cho tiếng Việt + tiếng Anh:
 *   - chuẩn hoá NFC, chữ thường; token = âm tiết / từ chữ-số;
 *   - **giữ nguyên mã** dạng `UC-09`, `REQ-INT-005`, `TC-INT-005` (một token, không tách theo dấu gạch);
 *   - thêm bản **bỏ dấu** của mỗi âm tiết có dấu ("xoá" ↔ "xoa") — người dùng hay gõ không dấu;
 *   - thêm **cặp âm tiết liền nhau** ("nhập_xuất", "điểm_danh") — tiếng Việt là ngôn ngữ âm tiết, một từ thường hai âm tiết.
 * Bỏ từ dừng phổ biến (và / của / the / of…) để chúng không chiếm điểm.
 */

const STOP = new Set(
  (
    "và với của cho các những một là thì mà để khi này đó được có không bị trong trên dưới ra vào theo từ đến như " +
    "va voi cua cho cac nhung mot la thi ma de khi nay do duoc co khong bi trong tren duoi ra vao theo tu den nhu " +
    "the a an of to and or in on for with by is are be as at it this that from"
  ).split(" ")
)

/** Mã tài liệu: chữ hoa / số nối bằng gạch ("UC-09", "REQ-INT-005", "BR-03", "FR-3.2.2"). */
const CODE = /\b[A-Za-z]{1,6}(?:[-_.][A-Za-z0-9]+)*[-_.]\d+(?:\.\d+)*\b/g
const WORD = /[\p{L}\p{N}]+/gu

export const foldDiacritics = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")

/** Token của một văn bản (có thể trùng — tần suất tính ở BM25). */
export const tokenize = (text: string): string[] => {
  const norm = text.normalize("NFC")
  const out: string[] = []
  for (const m of norm.matchAll(CODE)) out.push(m[0].toLowerCase())
  const words = [...norm.toLowerCase().matchAll(WORD)].map((m) => m[0])
  const kept = words.filter((w) => !STOP.has(w))
  for (const w of kept) {
    out.push(w)
    const folded = foldDiacritics(w)
    if (folded !== w) out.push(folded)
  }
  for (let i = 0; i + 1 < words.length; i++) {
    if (STOP.has(words[i]) || STOP.has(words[i + 1])) continue
    out.push(`${words[i]}_${words[i + 1]}`)
    const folded = `${foldDiacritics(words[i])}_${foldDiacritics(words[i + 1])}`
    if (folded !== `${words[i]}_${words[i + 1]}`) out.push(folded)
  }
  return out
}

export interface Bm25Hit<T> {
  item: T
  score: number
}

export interface Bm25Options {
  k1?: number
  b?: number
}

/**
 * Chỉ mục BM25 trên một tập văn bản. `search(query)` trả mọi văn bản có điểm > 0, điểm cao trước (hoà ⇒ giữ thứ tự gốc).
 */
export class Bm25<T> {
  private readonly docs: { item: T; tf: Map<string, number>; length: number }[]
  private readonly df = new Map<string, number>()
  private readonly avgLength: number
  private readonly k1: number
  private readonly b: number

  constructor(items: readonly T[], textOf: (item: T) => string, options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2
    this.b = options.b ?? 0.75
    this.docs = items.map((item) => {
      const tokens = tokenize(textOf(item))
      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      return { item, tf, length: tokens.length }
    })
    this.avgLength = this.docs.length ? this.docs.reduce((n, d) => n + d.length, 0) / this.docs.length : 0
  }

  private idf(term: string): number {
    const n = this.docs.length
    const df = this.df.get(term) ?? 0
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  search(query: string): Bm25Hit<T>[] {
    const terms = [...new Set(tokenize(query))]
    if (!terms.length || !this.docs.length) return []
    const hits: (Bm25Hit<T> & { order: number })[] = []
    this.docs.forEach((d, order) => {
      let score = 0
      for (const t of terms) {
        const f = d.tf.get(t)
        if (!f) continue
        const norm = this.avgLength ? d.length / this.avgLength : 1
        score += this.idf(t) * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * norm)))
      }
      if (score > 0) hits.push({ item: d.item, score, order })
    })
    return hits.sort((a, b) => b.score - a.score || a.order - b.order).map(({ item, score }) => ({ item, score }))
  }
}

/**
 * Reciprocal Rank Fusion: trộn nhiều danh sách đã xếp hạng (BM25, vector…) — điểm = Σ 1 / (k + hạng). Không cần cùng
 * thang điểm giữa các nguồn.
 */
export const reciprocalRankFusion = (lists: readonly (readonly string[])[], k = 60): Map<string, number> => {
  const out = new Map<string, number>()
  for (const list of lists) list.forEach((key, i) => out.set(key, (out.get(key) ?? 0) + 1 / (k + i + 1)))
  return out
}
