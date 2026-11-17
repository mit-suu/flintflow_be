/**
 * Câu rút lại yêu cầu đang dở, gõ ở bước làm rõ ("thôi không cần thêm nữa", "bỏ qua", "never mind", "không đổi nữa").
 *
 * Hai loại:
 * - Mở đầu bằng lời dừng (`thôi`, `bỏ qua`, `không cần`, `huỷ`, `dừng`, `cancel`…) — phần sau là gì cũng tính.
 * - FLF-439: cả câu chỉ là lời thôi đổi, phải có dấu hiệu dừng ("nữa", "khỏi") — "không đổi nữa", "không sửa gì nữa",
 *   "khỏi sửa", "no more changes". Cố ý KHÔNG nhận "không đổi", "giữ nguyên", "để như cũ" đứng một mình: đó thường là câu
 *   trả lời thật ("Có đổi cả tên màn không?" → "không đổi"; gợi ý mâu thuẫn "Giữ như cũ…").
 */

// Hết từ = không còn chữ cái theo sau (`\b` của JS coi "ỷ" là ký tự ngoài từ ⇒ "huỷ" không khớp)
const LEADING = /^\s*(thôi|thoi|bỏ qua|bo qua|không cần|khong can|huỷ|hủy|huy|dừng|dung lai|cancel|never ?mind|skip it|forget it|no need)(?!\p{L})/iu

const VERB = "(?:đổi|doi|sửa|sua|thêm|them|xoá|xóa|xoa|làm|lam|chỉnh|chinh)"
const FILLER = "(?:gì|gi|cả|ca|đâu|dau|luôn|luon|nha|nhé|nhe|nhá|ạ|đi|di|nào|nao)"
const END = `(?:\\s+${FILLER})*[\\s.!…]*$`

/** "không đổi nữa", "ko sửa gì nữa đâu", "vậy không thêm nữa nhé" — bắt buộc có "nữa". */
const NO_MORE = new RegExp(`^\\s*(?:(?:vậy|vay|thế|the|ok|oke|ừ|u)\\s+)?(?:không|khong|ko|k)\\s+${VERB}(?:\\s+${FILLER})*\\s+(?:nữa|nua)${END}`, "iu")
/** "khỏi", "khỏi sửa", "khỏi thêm nữa nha". */
const SKIP = new RegExp(`^\\s*(?:khỏi|khoi)(?:\\s+${VERB})?(?:\\s+(?:nữa|nua))?${END}`, "iu")
/** "no more changes", "drop it", "drop this request", "forget about it", "don't change anything". */
const EN_STOP = /^\s*(?:no more changes?|drop (?:it|this|this request|the request)|forget about it|don'?t change anything(?: else)?)(?:\s+(?:please|thanks))?[\s.!]*$/iu

export const isWithdrawal = (text: string): boolean => {
  const value = text.normalize("NFC")
  return LEADING.test(value) || NO_MORE.test(value) || SKIP.test(value) || EN_STOP.test(value)
}
