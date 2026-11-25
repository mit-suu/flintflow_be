/**
 * gap-quote.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-449 việc 16 (luật chất lượng (a)): mỗi chỗ thiếu của Brief (`other_requirements[kind=open_question]` do bước Danh
 * sách thiếu ghi) phải kèm `source_quote` - câu trong Brief / tài liệu làm nảy ra nhu cầu, chép nguyên văn. Không trích
 * được thì không đưa: code bỏ op thêm chỗ thiếu thiếu câu trích hoặc có câu trích không tìm thấy trong nguồn, TRƯỚC khi
 * kiểm lô (không tốn lượt thử, các op khác của lô giữ nguyên). Hàm thuần.
 */

import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { verifyQuote } from "../../shared/ai/quote-check.js"
import { parseStepId } from "./step-registry.js"

/** Bước Danh sách thiếu của Brief (template id, không có vòng). */
export const GAP_LIST_STEP = "S-1.4"

const GAP_PATH = "other_requirements[]"
const GAP_KIND = "open_question"

export interface DroppedGap {
  id: string | null
  statement: string
  source_quote: string | null
}

const stringsOf = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") {
    if (value.trim() !== "") out.push(value)
  } else if (Array.isArray(value)) {
    value.forEach((v) => stringsOf(v, out))
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => stringsOf(v, out))
  }
  return out
}

/**
 * Nguồn được trích cho chỗ thiếu: Brief = lời gốc + bản tiếng Anh của mọi addendum, mọi chữ trong `project`; cộng các
 * nguồn thêm của lượt (chữ tài liệu đã đưa model, yêu cầu sửa của user). Câu trích không tìm thấy ở đây là câu bịa.
 */
export const briefQuoteSources = (spine: Pick<Spine, "addendum" | "project">, extra: readonly (string | null | undefined)[] = []): string[] => [
  ...spine.addendum.flatMap((a) => [a.content, a.content_en]),
  ...stringsOf(spine.project),
  ...extra
].filter((s): s is string => typeof s === "string" && s.trim() !== "")

const isGapAdd = (op: Op): op is Op & { op: "add"; value: Record<string, unknown> } =>
  op.op === "add" &&
  op.path === GAP_PATH &&
  typeof op.value === "object" &&
  op.value !== null &&
  (op.value as Record<string, unknown>).kind === GAP_KIND

/**
 * Bỏ op thêm chỗ thiếu không có câu trích hoặc câu trích không là chuỗi con của nguồn (sau chuẩn hoá, `verifyQuote`).
 * Chỉ áp ở bước Danh sách thiếu; bước khác trả lô nguyên vẹn. Không đụng op sửa / xoá, giả định, hay mục `kind` khác.
 */
export const dropUngroundedGaps = (ops: readonly Op[], stepId: string, sources: readonly string[]): { ops: Op[]; dropped: DroppedGap[] } => {
  if (parseStepId(stepId).base !== GAP_LIST_STEP) return { ops: [...ops], dropped: [] }
  const dropped: DroppedGap[] = []
  const kept = ops.filter((op) => {
    if (!isGapAdd(op)) return true
    const quote = typeof op.value.source_quote === "string" ? op.value.source_quote : null
    if (quote !== null && verifyQuote(quote, sources)) return true
    dropped.push({
      id: typeof op.value.id === "string" ? op.value.id : null,
      statement: typeof op.value.statement === "string" ? op.value.statement : "",
      source_quote: quote
    })
    return false
  })
  return { ops: kept, dropped }
}
