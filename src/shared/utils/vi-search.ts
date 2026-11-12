/**
 * Tìm kiếm không phân biệt dấu tiếng Việt trên Mongo bằng `$regex`.
 *
 * `$regex` không theo collation, nên "ngan hang" không khớp "Ngân hàng". Thay vì lưu thêm một trường đã bỏ dấu, từ khoá
 * được bỏ dấu rồi mỗi nguyên âm / `d` thành một lớp ký tự gồm mọi biến thể có dấu: `ngan` ⇒ `ng[aàáạảã…]n`. Ký tự đặc
 * biệt của regex được escape nên từ khoá người dùng gõ không thành biểu thức.
 */

const VARIANTS: Record<string, string> = {
  a: "aàáạảãâầấậẩẫăằắặẳẵ",
  e: "eèéẹẻẽêềếệểễ",
  i: "iìíịỉĩ",
  o: "oòóọỏõôồốộổỗơờớợởỡ",
  u: "uùúụủũưừứựửữ",
  y: "yỳýỵỷỹ",
  d: "dđ",
}

/** Bỏ dấu + chữ thường: "Ngân Hàng Đông Á" ⇒ "ngan hang dong a". */
export const foldVietnamese = (value: string): string =>
  value.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase()

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Regex (không phân biệt hoa thường, không phân biệt dấu) khớp `query` ở bất kỳ vị trí nào. */
export const vietnameseSearchPattern = (query: string): RegExp => {
  const source = [...foldVietnamese(query.trim())].map((ch) => (VARIANTS[ch] ? `[${VARIANTS[ch]}]` : escapeRegex(ch))).join("")
  return new RegExp(source, "i")
}
