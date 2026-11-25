/**
 * quote-check.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-449 N2, luật chất lượng (a): mỗi gợi ý của AI trỏ về một câu trích, không trích được thì không đưa ra. Model hay
 * "trích" bằng cách diễn lại hoặc bịa, nên code hậu kiểm: câu trích phải là **chuỗi con** của một trong các nguồn (lời
 * gốc addendum, đoạn tài liệu, chữ SRS) sau khi chuẩn hoá. Mục không đạt thì bỏ, không sửa hộ.
 *
 * Chuẩn hoá (cả câu trích lẫn nguồn): Unicode NFC (tiếng Việt dựng sẵn / tổ hợp), dấu nháy cong ⇒ thẳng, gạch ngang dài ⇒
 * `-`, gộp khoảng trắng, không phân biệt hoa thường. Câu trích còn được bỏ dấu câu ở hai đầu (model hay thêm / bớt dấu
 * chấm cuối) và được cắt bằng dấu ba chấm: từng phần phải có mặt, đúng thứ tự, trong cùng một nguồn.
 *
 * Tiền lệ: `verifiedExcerpt` (`pipeline/question-shape.ts`) cho câu trả lời trích từ tin nhắn user.
 */

/** Câu trích ngắn hơn mức này (ký tự, sau chuẩn hoá) không chứng minh được gì - "a", "ok" khớp với mọi nguồn. */
export const MIN_QUOTE_LENGTH = 4

const SINGLE_QUOTES = /[‘’‚‛′`´]/g
const DOUBLE_QUOTES = /[“”„‟″«»]/g
const DASHES = /[‐-―−]/g
const ELLIPSIS = /…|\.{3,}/
/** Dấu câu / nháy bao quanh câu trích, bỏ ở hai đầu. */
const EDGE_PUNCTUATION = /^[\s"'.,;:!?()[\]-]+|[\s"'.,;:!?()[\]-]+$/g

/** Chuẩn hoá một đoạn chữ để so chuỗi con (dùng cho cả nguồn lẫn câu trích). */
export const normalizeQuoteText = (text: string): string =>
  text
    .normalize("NFC")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

/** Các phần của câu trích (cắt bằng dấu ba chấm), đã chuẩn hoá và bỏ dấu câu hai đầu. Phần rỗng bị bỏ. */
const quoteParts = (quote: string): string[] =>
  normalizeQuoteText(quote)
    .split(ELLIPSIS)
    .map((part) => part.replace(EDGE_PUNCTUATION, "").trim())
    .filter((part) => part !== "")

/** Mọi phần có mặt trong `source`, đúng thứ tự, không chồng lên nhau. */
const containsInOrder = (source: string, parts: readonly string[]): boolean => {
  let from = 0
  for (const part of parts) {
    const at = source.indexOf(part, from)
    if (at < 0) return false
    from = at + part.length
  }
  return true
}

/**
 * Vị trí của nguồn chứa câu trích (chỉ số trong `sources`), `-1` nếu không nguồn nào chứa, câu trích rỗng hoặc quá ngắn.
 * Nguồn rỗng / `null` / `undefined` bị bỏ qua (gọi được thẳng với field tuỳ chọn).
 */
export const findQuoteSource = (quote: string | null | undefined, sources: readonly (string | null | undefined)[]): number => {
  if (typeof quote !== "string") return -1
  const parts = quoteParts(quote)
  if (parts.join("").replace(/\s/g, "").length < MIN_QUOTE_LENGTH) return -1
  return sources.findIndex((source) => typeof source === "string" && source !== "" && containsInOrder(normalizeQuoteText(source), parts))
}

/** Câu trích là chuỗi con (sau chuẩn hoá) của ít nhất một nguồn. */
export const verifyQuote = (quote: string | null | undefined, sources: readonly (string | null | undefined)[]): boolean =>
  findQuoteSource(quote, sources) >= 0
