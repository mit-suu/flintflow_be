/**
 * FLF-375 (business-flow §3.2 "Hai người sửa cùng lúc"): so hai bản theo **từ** để (1) tô màu như Track Changes trên màn
 * 3 cột và (2) biết yêu cầu gốc có **đụng thẳng** phần người khác vừa sửa không — đụng thì AI hỏi lại trong chat, không tự chọn.
 * LCS theo từ, không phụ thuộc thư viện; văn bản dài cắt ở `MAX_TOKENS` — đủ cho một phần tử SRS.
 */

export interface DiffSpan {
  /** Đoạn trong bản gốc bị thay (chỉ số từ, `end` không gồm); `start === end` ⇒ chèn vào vị trí đó. */
  start: number
  end: number
  /** Các từ của bản mới đứng vào chỗ đó (rỗng ⇒ xoá). */
  added: string[]
}

const MAX_TOKENS = 1500

export const tokenize = (text: string): string[] => text.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS)

/** Các đoạn khác nhau giữa `a` và `b` (vị trí tính trên `a`). */
export const wordDiff = (a: string, b: string): DiffSpan[] => {
  const x = tokenize(a)
  const y = tokenize(b)
  const n = x.length
  const m = y.length
  // lcs[i][j] = độ dài LCS của x[i..] và y[j..]
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const spans: DiffSpan[] = []
  let i = 0
  let j = 0
  let open: DiffSpan | null = null
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      if (open) spans.push(open)
      open = null
      i++
      j++
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      open ??= { start: i, end: i, added: [] }
      open.added.push(y[j])
      j++
    } else {
      open ??= { start: i, end: i, added: [] }
      open.end = i + 1
      i++
    }
  }
  if (open) spans.push(open)
  return spans
}

/** Hai đoạn chạm nhau (chồng hoặc liền kề — chèn ngay cạnh chữ bị đổi cũng là đụng). */
const touches = (p: DiffSpan, q: DiffSpan): boolean => p.start <= q.end && q.start <= p.end

export interface DirectHit {
  /** Chữ gốc ① ở chỗ cả hai cùng đụng. */
  original: string
  /** Người khác đã đổi thành gì (②). */
  theirs: string
  /** Đề xuất của bạn định đổi thành gì (③). */
  yours: string
}

/** Bản mới của đoạn `[lo, hi)` trong `tokens` sau khi áp `spans`. */
const applied = (tokens: string[], spans: DiffSpan[], lo: number, hi: number): string => {
  const out: string[] = []
  let i = lo
  for (const s of [...spans].sort((p, q) => p.start - q.start)) {
    out.push(...tokens.slice(i, s.start), ...s.added)
    i = s.end
  }
  out.push(...tokens.slice(i, hi))
  return out.join(" ")
}

/**
 * Yêu cầu gốc có đụng thẳng phần người khác vừa sửa không: ① → ② (họ đổi gì) và ① → ③ (mình định đổi gì) có đoạn chạm
 * nhau ⇒ trả về ba bản của đúng đoạn đó để hỏi lại; không chạm ⇒ `null` (AI áp yêu cầu gốc lên ② được).
 */
export const directHit = (atProposal: string, current: string, proposal: string): DirectHit | null => {
  const theirs = wordDiff(atProposal, current)
  const mine = wordDiff(atProposal, proposal)
  const hitTheirs = theirs.filter((p) => mine.some((q) => touches(p, q)))
  const hitMine = mine.filter((q) => theirs.some((p) => touches(p, q)))
  if (!hitTheirs.length || !hitMine.length) return null
  const tokens = tokenize(atProposal)
  const all = [...hitTheirs, ...hitMine]
  const lo = Math.min(...all.map((s) => s.start))
  const hi = Math.max(...all.map((s) => s.end))
  return { original: tokens.slice(lo, hi).join(" "), theirs: applied(tokens, hitTheirs, lo, hi), yours: applied(tokens, hitMine, lo, hi) }
}
