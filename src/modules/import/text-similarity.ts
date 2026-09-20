/**
 * So khớp tiêu đề/tên cột không phân biệt hoa thường và dấu tiếng Việt (I-3). FLF-171.
 */

/** `Đặc tả Use Case (1)` ⇒ `dac ta use case 1`. */
export const foldText = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

const STOP_WORDS = new Set(["the", "of", "and", "a", "an", "list", "s", "va", "cua", "danh", "sach"])

export const foldTokens = (s: string): string[] => foldText(s).split(" ").filter((t) => t && !STOP_WORDS.has(t))

/** Dice trên tập token (0…1); chuỗi gập trùng nhau ⇒ 1. */
export const titleSimilarity = (a: string, b: string): number => {
  const fa = foldText(a)
  const fb = foldText(b)
  if (!fa || !fb) return 0
  if (fa === fb) return 1
  const ta = new Set(foldTokens(a).map(stem))
  const tb = new Set(foldTokens(b).map(stem))
  if (!ta.size || !tb.size) return 0
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  return (2 * common) / (ta.size + tb.size)
}

/** Bỏ đuôi số nhiều tiếng Anh đơn giản: `descriptions` ≈ `description`. */
const stem = (t: string): string => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t)

/** `3.2.1  Register account` ⇒ `{ number: "3.2.1", title: "Register account" }`; `II. Software…` ⇒ số La Mã. */
export const splitHeadingNumber = (text: string): { number: string | null; title: string } => {
  const m = /^\s*((?:\d{1,2}\.)*\d{1,2}|[IVX]{1,4})\.?[\s ]+(.*)$/.exec(text)
  if (!m || !m[2].trim()) return { number: null, title: text.trim() }
  return { number: m[1], title: m[2].trim() }
}
