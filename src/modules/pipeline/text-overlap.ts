/**
 * text-overlap.ts
 * ─────────────────────────────────────────────────────────────────
 * So gần nghĩa hai đoạn tiếng Việt/Anh bằng TỪ NỘI DUNG (bỏ dấu, hạ thường, bỏ từ chức năng) — không thư viện, không gọi
 * model. Dùng chung cho tin nhắn cổng (điều tạm hiểu đã được nói chưa) và bộ lọc op (giả định mới có trùng giả định đã có).
 */

const WORDS = /[\p{L}\p{N}]+/gu

/** Bỏ dấu + hạ chữ thường: model gõ có/không dấu, hoa/thường đều khớp. */
export const normalise = (text: string): string => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d")

export const wordsOf = (text: string): string[] => normalise(text).match(WORDS) ?? []

/** Từ chức năng / xưng hô — không mang nội dung nên không dùng để so khớp. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  "la va cua cho cac mot nhung duoc khong co de se toi ban minh tam hieu nhu thi ma nen cung dang da voi trong tren nay do khi neu hay hoac o tu den ra vao rat can phai the a an and of to for in on is are be by with or it this that".split(" ")
)

/** Tập từ nội dung (không trùng) của một đoạn. */
export const contentWords = (text: string): Set<string> => new Set(wordsOf(text).filter((w) => !STOP_WORDS.has(w)))

/**
 * Tỷ lệ từ nội dung của đoạn NGẮN hơn có mặt trong đoạn kia (0–1). Chọn mẫu số là đoạn ngắn để bắt được câu diễn lại có
 * thêm chi tiết ("… ngoài 800–1.000 lượt khám mỗi ngày"). Đoạn nào không có từ nội dung ⇒ 0.
 */
export const overlapRatio = (a: string, b: string): number => {
  const wa = contentWords(a)
  const wb = contentWords(b)
  if (wa.size === 0 || wb.size === 0) return 0
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa]
  let shared = 0
  for (const w of small) if (large.has(w)) shared++
  return shared / small.size
}

/** Tách đoạn thành câu theo dấu kết câu; giữ dấu ở cuối mỗi câu. */
export const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?…])\s+/u).filter((p) => p.trim() !== "")
