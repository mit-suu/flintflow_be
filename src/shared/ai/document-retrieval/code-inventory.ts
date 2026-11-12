/**
 * Danh mục mã trong tài liệu tham khảo (FLF-393) — hàm thuần, Code đếm, không gọi model.
 *
 * Câu hỏi "có bao nhiêu use case / business rule", "liệt kê các màn hình" là câu hỏi toàn cục: tìm đoạn (BM25) chỉ đưa cho
 * model một phần tài liệu, model đành đoán — demo 2026-11-12 trên SRS 82 UC / 35 BR, model trả lời "81 use case (UC-01 đến
 * UC-82)" và "ít nhất BR-34". Đếm mã là việc của Code (business-flow §3.4: "Code … tìm chữ, đếm … chạy theo luật, không
 * đoán"): quét toàn văn, gom mã theo loại, đưa con số chính xác vào ngữ cảnh.
 *
 * Mã = tiền tố 2–5 chữ HOA, gạch nối, số (`UC-05`, `BR-12`, `SCR-03`, `NFR-36`). Chỉ đếm mã **được định nghĩa**: mã mở
 * đầu một dòng (heading "UC-05 Đặt lịch", ô bảng "UC-05", dòng "BR-01: …", có thể có gạch đầu dòng trước). Mã nằm giữa câu
 * là tham chiếu — "bỏ UC-23" trong lịch sử thay đổi, "CR-004 is logged" trong ví dụ — đếm vào là sai số lượng. Loại chỉ có
 * một mã bị bỏ — thường là tham chiếu lẻ, không phải danh mục yêu cầu.
 */

/** Mã mở đầu một dòng, sau dấu đầu dòng / khoảng trắng tuỳ chọn. */
const DEFINED_CODE_RE = /^[\s•*\-–—]*([A-Z]{2,5})-(\d{1,4})(?![\p{L}\p{N}])/u

/** Loại mã cần ít nhất ngần này mã khác nhau mới vào danh mục. */
export const MIN_CODES_PER_PREFIX = 2

export interface CodeFamily {
  prefix: string
  /** Số của các mã khác nhau, tăng dần. */
  numbers: number[]
  /** Số chữ số khi in (`UC-05` ⇒ 2), theo cách tài liệu viết nhiều nhất. */
  width: number
  /** Số nằm trong khoảng [nhỏ nhất, lớn nhất] mà tài liệu không nhắc tới. */
  missing: number[]
}

export const formatCode = (prefix: string, n: number, width: number): string => `${prefix}-${String(n).padStart(width, "0")}`

/** Gom mã theo tiền tố từ các đoạn chữ của MỘT tài liệu. Thứ tự: nhiều mã trước, rồi theo tên. */
export const codeInventory = (texts: readonly string[]): CodeFamily[] => {
  const byPrefix = new Map<string, { numbers: Set<number>; widths: Map<number, number> }>()
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const m = DEFINED_CODE_RE.exec(line)
      if (!m) continue
      const prefix = m[1]!
      const digits = m[2]!
      const entry = byPrefix.get(prefix) ?? { numbers: new Set<number>(), widths: new Map<number, number>() }
      entry.numbers.add(Number(digits))
      entry.widths.set(digits.length, (entry.widths.get(digits.length) ?? 0) + 1)
      byPrefix.set(prefix, entry)
    }
  }
  const families: CodeFamily[] = []
  for (const [prefix, { numbers, widths }] of byPrefix) {
    if (numbers.size < MIN_CODES_PER_PREFIX) continue
    const sorted = [...numbers].sort((a, b) => a - b)
    const present = new Set(sorted)
    const missing: number[] = []
    for (let n = sorted[0]!; n <= sorted[sorted.length - 1]!; n++) if (!present.has(n)) missing.push(n)
    const width = [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0]
    families.push({ prefix, numbers: sorted, width, missing })
  }
  return families.sort((a, b) => b.numbers.length - a.numbers.length || a.prefix.localeCompare(b.prefix))
}

/** Liệt kê tối đa ngần này mã thiếu; nhiều hơn thì chỉ báo số lượng. */
const MAX_MISSING_LISTED = 10

/** `UC: 82 mã (UC-01 → UC-82, liên tục)` / `SCR: 30 mã (SCR-01 → SCR-33, không có SCR-07, SCR-19, SCR-20)`. */
export const describeFamily = (f: CodeFamily): string => {
  const first = formatCode(f.prefix, f.numbers[0]!, f.width)
  const last = formatCode(f.prefix, f.numbers[f.numbers.length - 1]!, f.width)
  const range = f.numbers.length === 1 ? first : `${first} → ${last}`
  const gaps =
    f.missing.length === 0
      ? "liên tục"
      : f.missing.length <= MAX_MISSING_LISTED
        ? `không có ${f.missing.map((n) => formatCode(f.prefix, n, f.width)).join(", ")}`
        : `thiếu ${f.missing.length} số trong khoảng`
  return `${f.prefix}: ${f.numbers.length} mã (${range}, ${gaps})`
}

export const INVENTORY_HEADER =
  "[Danh mục mã trong tài liệu — Code đếm trên TOÀN VĂN các mã được định nghĩa (mã mở đầu một dòng; mã chỉ được nhắc tới trong câu " +
  "không tính), chính xác. Hỏi \"bao nhiêu\" / \"liệt kê\" thì trả lời đúng con số này, không ước lượng, không nói \"khoảng\" / " +
  "\"ít nhất\". Code inventory of codes defined over the full text — exact.]"

/** Một dòng cho mỗi tài liệu có mã; không tài liệu nào có mã ⇒ `""`. */
export const formatInventory = (docs: readonly { label: string; families: readonly CodeFamily[] }[]): string => {
  const lines = docs.filter((d) => d.families.length > 0).map((d) => `- ${d.label}: ${d.families.map(describeFamily).join(" · ")}`)
  return lines.length ? `${INVENTORY_HEADER}\n${lines.join("\n")}` : ""
}
