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

/**
 * Ngưỡng từ nội dung trùng để coi hai đoạn là nói cùng một điều. Đo trên lượt chạy thật: câu diễn lại kèm chi tiết thêm đạt
 * 0.78–0.83; hai câu khác nhau nhưng cùng chủ đề (kênh báo qua app / dịch vụ SMS) 0.63.
 */
const ASSUMPTION_OVERLAP_RATIO = 0.75
/** Câu quá ngắn (ít từ nội dung) chỉ so nguyên văn — vài từ trùng không đủ nói lên cùng nghĩa ("Assumption B-1.1" / "B-1.2"). */
export const ASSUMPTION_OVERLAP_MIN_WORDS = 5
/** Từ phủ định: "không cần thanh toán online" và "cần thanh toán online" trùng gần hết từ nhưng ngược nghĩa. */
const NEGATION = /(^|[^a-z0-9])(khong|chua|not|no|never)([^a-z0-9]|$)/
const negated = (text: string): boolean => NEGATION.test(normalise(text))

/** Cùng chiều khẳng định/phủ định và cả hai đủ dài để so bằng từ nội dung. */
const comparable = (a: string, b: string): boolean =>
  negated(a) === negated(b) && contentWords(a).size >= ASSUMPTION_OVERLAP_MIN_WORDS && contentWords(b).size >= ASSUMPTION_OVERLAP_MIN_WORDS

/**
 * Hai câu nói cùng một điều — mẫu số là đoạn NGẮN hơn, nên câu diễn lại kèm chi tiết thêm vẫn tính là trùng. Đây là phép đo
 * cho câu hỏi "giả định mới này có phải diễn lại giả định đã có" (bộ lọc op): thêm chi tiết vào một giả định đã có vẫn là
 * trùng, không được ghi thành bản ghi thứ hai.
 */
export const restatesAssumption = (next: string, existing: string | null | undefined): boolean =>
  typeof existing === "string" && comparable(next, existing) && overlapRatio(next, existing) >= ASSUMPTION_OVERLAP_RATIO

/**
 * Tỷ lệ từ nội dung của `target` có mặt trong `text` (0–1) — MỘT CHIỀU, mẫu số luôn là `target`.
 */
const coverageRatio = (text: string, target: string): number => {
  const want = contentWords(target)
  if (want.size === 0) return 0
  const have = contentWords(text)
  let shared = 0
  for (const w of want) if (have.has(w)) shared++
  return shared / want.size
}

/**
 * `sentence` có nói ra ĐỦ nội dung của `assumption` chưa — mẫu số là `assumption`, không phải đoạn ngắn hơn.
 *
 * Khác `restatesAssumption` ở đúng chỗ quan trọng: ở đây câu nói thiếu KHÔNG được tính. "Tôi đoán hồ sơ khám được lưu theo
 * quy định" là tập con của giả định "Hồ sơ khám lưu tối thiểu 10 năm theo quy định" nên `overlapRatio` (mẫu số là đoạn ngắn)
 * cho 1.0 — trong khi "10 năm", phần user cần xác nhận, chưa được nói. Dùng để quyết định điều nào được xác nhận ở cổng thì
 * phải đo theo chiều phủ: thiếu một phần ⇒ coi là chưa nói ⇒ điều đó ở lại `unconfirmed` (vô hại), còn tính là đã nói thì
 * ghi `confirmed` cho điều user chưa đọc.
 */
export const coversAssumption = (sentence: string, assumption: string): boolean =>
  comparable(sentence, assumption) && coverageRatio(sentence, assumption) >= ASSUMPTION_OVERLAP_RATIO
