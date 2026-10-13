/**
 * Embedding giả cho test / smoke (`EMBEDDING_PROVIDER=mock` hoặc `AI_PROVIDER_OVERRIDE=mock`): túi từ băm, tất định,
 * không gọi mạng. Hai câu chung nhiều từ ⇒ cosine cao; không có từ chung ⇒ ~0. Không hiểu từ đồng nghĩa — test cần
 * ca "đồng nghĩa" thì stub thẳng tầng tìm kiếm vector.
 */

const TOKEN = /[\p{L}\p{N}]+/gu

/** FNV-1a 32 bit — đủ rải đều token vào các chiều. */
const fnv1a = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export const l2Normalize = (v: number[]): number[] => {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? v.map((x) => x / norm) : v
}

export const mockEmbedding = (text: string, dimensions: number): number[] => {
  const v = new Array<number>(dimensions).fill(0)
  for (const token of text.toLowerCase().match(TOKEN) ?? []) {
    const h = fnv1a(token)
    v[h % dimensions] += h & 0x80000000 ? -1 : 1
  }
  return l2Normalize(v)
}
