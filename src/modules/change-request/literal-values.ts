/**
 * FLF-483 (M4-a, plan fix #14): **giá trị cụ thể** mà CR đổi ("5 triệu", "30 phút", "15%") phải tìm ra chắc chắn ở mọi
 * phần tử đang ghi giá trị đó, không đi qua xếp hạng từ khoá (BM25 chuẩn hoá theo từng từ khoá + trần `KEYWORD_MAX_HITS`
 * làm phần tử có chữ "5 triệu" nhưng điểm thấp bị cắt - ChoViet #4). Hàm thuần - không DB, không AI.
 * Chỉ nhận **số + đơn vị**: mã tài liệu ("UC-16"), số mục ("3.4.1"), số phiên bản ("1.0"), câu đếm phần tử ("15 use case")
 * không có đơn vị trong danh sách nên tự rơi ra ngoài; mã tài liệu còn bị xoá trước khi quét cho chắc.
 */

import { foldDiacritics } from "../../shared/search/bm25.js"
import type { IChangeRequest } from "./change-request.model.js"

export interface Literal {
  raw: string
  kind: "money" | "phrase"
  /** `money`: số tiền quy về đồng. */
  amount?: number
  /** Dạng so khớp: tiền ⇒ số đồng; còn lại ⇒ "số đơn vị" bỏ dấu, chữ thường, bỏ dấu phân cách nghìn. */
  folded: string
}

const CODE = /\b[A-Za-z]{1,6}(?:[-_.][A-Za-z0-9]+)*[-_.]\d+(?:\.\d+)*\b/g

const MONEY_UNITS: Readonly<Record<string, number>> = { tỷ: 1e9, tỉ: 1e9, triệu: 1e6, tr: 1e6, nghìn: 1e3, ngàn: 1e3, k: 1e3, đồng: 1, đ: 1, vnđ: 1, vnd: 1 }
const OTHER_UNITS = "phút|giờ|ngày|tuần|tháng|năm|giây|ms|s|%|lần|sản phẩm|người dùng|minutes?|mins?|hours?|days?|weeks?|months?|years?|seconds?|secs?|times|users?|items?|products?"

const NUMBER = "\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:[.,]\\d+)?"
const START = "(?<![\\p{L}\\p{N}.,-])"
const END = "(?![\\p{L}\\p{N}])"
const MONEY = new RegExp(`${START}(${NUMBER})\\s*(${Object.keys(MONEY_UNITS).sort((a, b) => b.length - a.length).join("|")})${END}`, "giu")
const PHRASE = new RegExp(`${START}(${NUMBER})\\s*(${OTHER_UNITS})${END}`, "giu")

/** "5.000.000" / "5,000,000" ⇒ 5000000; "1,5" / "1.5" ⇒ 1.5. */
const parseNumber = (s: string): number => (/^\d{1,3}(?:[.,]\d{3})+$/.test(s) ? Number(s.replace(/[.,]/g, "")) : Number(s.replace(",", ".")))

const blankCodes = (text: string): string => text.replace(CODE, " ")

/** Mọi giá trị cụ thể của một đoạn chữ, theo thứ tự xuất hiện, không trùng. */
export const literalValues = (text: string): Literal[] => {
  const clean = blankCodes(text)
  const out = new Map<string, Literal>()
  for (const m of clean.matchAll(MONEY)) {
    const unit = MONEY_UNITS[m[2].toLowerCase()]
    const amount = Math.round(parseNumber(m[1]) * unit)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const folded = `vnd:${amount}`
    if (!out.has(folded)) out.set(folded, { raw: m[0].trim(), kind: "money", amount, folded })
  }
  for (const m of clean.matchAll(PHRASE)) {
    const n = parseNumber(m[1])
    if (!Number.isFinite(n)) continue
    const folded = `${n} ${foldDiacritics(m[2]).toLowerCase()}`
    if (!out.has(folded)) out.set(folded, { raw: m[0].trim(), kind: "phrase", folded })
  }
  return [...out.values()]
}

const plainText = (value: unknown): string => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(plainText).join("\n")
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map(plainText).join("\n")
  return ""
}

/** Path các phần tử có chứa ít nhất một trong các giá trị (tiền so theo số đồng, cụm khác so theo dạng đã chuẩn hoá). */
export const literalHits = (elements: readonly { path: string; value: unknown }[], literals: readonly Literal[]): string[] => {
  if (!literals.length) return []
  const wanted = new Set(literals.map((l) => l.folded))
  return elements.filter((e) => literalValues(plainText(e.value)).some((l) => wanted.has(l.folded))).map((e) => e.path)
}

/**
 * Chữ của CR để rút giá trị cụ thể: tiêu đề, mô tả, lệnh gộp thêm, câu trả lời làm rõ, từ khoá C-2 có chữ số. Giống
 * `crQueryText` nhưng không cắt độ dài và không lấy câu hỏi (câu hỏi có thể nêu giá trị mẫu mà người dùng không chọn).
 */
export const crLiteralText = (cr: Pick<IChangeRequest, "title" | "description" | "clarifications" | "amendments" | "targets">): string =>
  [
    cr.title,
    cr.description,
    ...(cr.amendments ?? []).map((a) => a.text),
    ...(cr.clarifications ?? []).flatMap((c) => c.answers),
    ...(cr.targets?.keywords ?? []).filter((k) => /\d/.test(k))
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n")
