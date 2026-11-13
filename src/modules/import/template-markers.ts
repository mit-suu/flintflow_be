/**
 * FLF-411: chữ của **mẫu** (không phải nội dung khách viết) mà luật trọn đoạn `[ ]` / `{ }` (FLF-364, `instruction-text.ts`) không
 * thấy — template FPT Capstone "Report3":
 *
 * 1. Khoảng hướng dẫn **nhiều đoạn**: `[An actor is …` mở ở một đoạn, list / hình ở giữa, `… as below]` đóng ở đoạn sau. Đoạn chỉ có
 *    ngoặc đóng (đuôi của khoảng mở dưới heading nhóm, hoặc đoạn `]` lẻ) cũng là hướng dẫn.
 * 2. Khoảng ví dụ `<<Sample: … >>`: đoạn mở `<<`, hình mẫu, đoạn `>>` riêng. Đoạn trọn `<<Function Name 1>>` là chỗ điền.
 * 3. Ô / dòng chỗ điền của bảng: `<<…>>`, `..`, `…`, `-`; dòng chỉ còn số thứ tự + chỗ điền, hoặc ô tên là chỗ điền.
 * 4. (chỉ để quyết khung mẫu hay SRS đã viết) bảng / hình mẫu ở mục có chữ hướng dẫn: bảng có cột trống ở mọi dòng, hướng dẫn
 *    nói "sample / as below", hình mà ngoài hình ra mục không còn gì khách viết.
 *
 * Luật 1–3 đúng cho mọi file (màn đọc khung, I-5). Luật 4 chỉ dùng tính tỉ lệ `kind` — file viết thật có thể giữ hướng dẫn cạnh
 * bảng / hình thật, nên không chặn trích nội dung. Hàm thuần.
 */

import { isInstructionText } from "../../shared/utils/instruction-text.js"
import type { LayoutBlock } from "./step-plan.js"

export type TemplateMark = "guidance" | "sample" | "placeholder"

const clean = (text: string | null | undefined): string => (text ?? "").replace(/ /g, " ").trim()

const PLACEHOLDER = /^(<<[^<>]*>>|\.{2,}|…+|[-–—]|\?+)$/

/** Ô / đoạn chỉ là chỗ điền của mẫu: `<<Screen Name1>>`, `..`, `…`, `-`. */
export const isPlaceholderText = (text: string | null | undefined): boolean => PLACEHOLDER.test(clean(text))

/** Cột số thứ tự (`1`, `01`, `#`) — không phải nội dung của dòng. */
const isIndexCell = (cell: string): boolean => /^(#|\d{1,3}\.?)$/.test(clean(cell))

/** Dòng thân bảng mẫu: ngoài số thứ tự chỉ còn chỗ điền / trống, hoặc ô tên (ô chữ đầu tiên) là chỗ điền. */
export const isPlaceholderRow = (row: readonly string[]): boolean => {
  const cells = row.map(clean)
  const body = cells[0] !== undefined && isIndexCell(cells[0]) ? cells.slice(1) : cells
  const filled = body.filter((c) => c && !isPlaceholderText(c))
  if (!filled.length) return true
  const first = body.find((c) => c)
  return first !== undefined && isPlaceholderText(first)
}

/** Bảng sau khi bỏ chỗ điền: ô chỗ điền thành rỗng, dòng thân chỗ điền bị bỏ (hàng tiêu đề giữ nguyên). */
export const cleanTableRows = (rows: readonly (readonly string[])[]): string[][] => {
  if (!rows.length) return []
  const [header, ...body] = rows
  const kept = body.filter((r) => !isPlaceholderRow(r)).map((r) => r.map((c) => (isPlaceholderText(c) ? "" : c)))
  // Bỏ hết thân ⇒ giữ một dòng trống: bảng một dòng bị `tableBodyHasRealText` coi là bảng không tiêu đề (tiêu đề thành "dữ liệu")
  return [[...header], ...(kept.length || !body.length ? kept : [header.map(() => "")])]
}

const depth = (text: string, open: string, close: string): number => [...text].reduce((d, ch) => d + (ch === open ? 1 : ch === close ? -1 : 0), 0)

const isTextBlock = (b: Pick<LayoutBlock, "kind">): boolean => b.kind === "paragraph" || b.kind === "list_item"

/**
 * Khối là chữ của mẫu theo luật 1–2 (+ đoạn chỗ điền của luật 3), theo thứ tự file. Khoảng chưa đóng dừng ở heading kế. Khối
 * con của bảng (`table_row` / `table_cell`) theo khối bảng.
 */
export const templateMarks = (blocks: readonly Pick<LayoutBlock, "block_id" | "kind" | "text">[]): Map<string, TemplateMark> => {
  const marks = new Map<string, TemplateMark>()
  let open: { mark: TemplateMark; close: string; opener: string } | null = null
  // Khoảng hướng dẫn bị heading cắt ngang (mở dưới heading nhóm "2.2 Use Cases", đóng dưới "2.2.2") — chỉ khi đó đoạn chỉ có ngoặc
  // đóng mới là hướng dẫn; khách viết đè chữ hướng dẫn còn sót `]` cuối câu là nội dung
  let dangling: { close: string; opener: string } | null = null
  for (const b of blocks) {
    if (b.kind === "heading") {
      if (open?.mark === "guidance") dangling = { close: open.close, opener: open.opener }
      open = null
      continue
    }
    if (b.kind === "table_row" || b.kind === "table_cell") continue
    const text = clean(b.text)
    if (open) {
      marks.set(b.block_id, open.mark)
      if (isTextBlock(b) && (open.close === ">>" ? text.includes(">>") : depth(text, open.opener, open.close) < 0 || text.endsWith(open.close))) open = null
      continue
    }
    if (!isTextBlock(b) || !text) continue
    if (text.startsWith("<<")) {
      marks.set(b.block_id, isPlaceholderText(text) ? "placeholder" : "sample")
      if (!text.includes(">>")) open = { mark: "sample", close: ">>", opener: "<<" }
    } else if (isInstructionText(text)) {
      marks.set(b.block_id, "guidance")
    } else if ((text.startsWith("[") && depth(text, "[", "]") > 0) || (text.startsWith("{") && depth(text, "{", "}") > 0)) {
      marks.set(b.block_id, "guidance")
      open = text.startsWith("[") ? { mark: "guidance", close: "]", opener: "[" } : { mark: "guidance", close: "}", opener: "{" }
    } else if (text === "]" || text === "}" || (dangling && text.endsWith(dangling.close) && depth(text, dangling.opener, dangling.close) < 0)) {
      // Đuôi của khoảng hướng dẫn mở dưới heading nhóm phía trên ("This part describes the use cases, … as below]") / `]` lẻ
      marks.set(b.block_id, "guidance")
      dangling = null
    } else if (isPlaceholderText(text)) {
      marks.set(b.block_id, "placeholder")
    }
  }
  return marks
}

/** Khối còn lại sau khi bỏ chữ của mẫu (luật 1–3): khối thuộc khoảng hướng dẫn / ví dụ bị bỏ, bảng bỏ chỗ điền. */
export const stripTemplateMarks = <B extends Pick<LayoutBlock, "block_id" | "kind" | "text" | "rows">>(blocks: readonly B[]): B[] => {
  const marks = templateMarks(blocks)
  return blocks.filter((b) => !marks.has(b.block_id)).map((b) => (b.kind === "table" && b.rows ? { ...b, rows: cleanTableRows(b.rows) } : b))
}

/** Hướng dẫn nói bảng / hình theo sau là mẫu. */
const SAMPLE_LEAD = /\b(sample|samples|as below|the following|like the one below)\b|(như|theo) (mẫu|bảng|hình) (dưới|sau)|mẫu dưới đây/i

/** Bảng có cột (ngoài cột số thứ tự) trống ở mọi dòng thân — khung bảng mẫu (Actors / Use Case / Entity chỉ có tên, mô tả trống). */
export const isSkeletonTable = (rows: readonly (readonly string[])[]): boolean => {
  const body = cleanTableRows(rows).slice(1)
  if (!body.length) return true
  const width = Math.max(...body.map((r) => r.length))
  return Array.from({ length: width }, (_, c) => body.map((r) => clean(r[c]))).some((column) => column.every((cell) => cell === ""))
}

/**
 * Luật 4 — bảng / hình **mẫu** (chỉ để quyết `kind`): ở mục có chữ hướng dẫn (luật 1 hoặc trọn đoạn `[ ]`), bảng khung
 * (`isSkeletonTable`) hoặc mọi bảng / hình khi hướng dẫn nói "sample / as below"; hình trong mục mà ngoài hình không còn khối
 * khách viết.
 */
export const sampleBlockIds = <B extends Pick<LayoutBlock, "block_id" | "kind" | "text" | "rows" | "section_id">>(blocks: readonly B[]): Set<string> => {
  const marks = templateMarks(blocks)
  const guided = new Set<string>()
  const leads = new Set<string>()
  for (const b of blocks) {
    if (!b.section_id || marks.get(b.block_id) !== "guidance") continue
    guided.add(b.section_id)
    if (SAMPLE_LEAD.test(b.text)) leads.add(b.section_id)
  }
  const out = new Set<string>()
  const authoredText = new Set<string>()
  for (const b of blocks) {
    if (!b.section_id || marks.has(b.block_id) || !guided.has(b.section_id)) continue
    if (b.kind === "table" && b.rows && (leads.has(b.section_id) || isSkeletonTable(b.rows))) out.add(b.block_id)
    else if (b.kind === "image" && leads.has(b.section_id)) out.add(b.block_id)
    else if (b.kind !== "image" && b.kind !== "table" && isTextBlock(b) && clean(b.text)) authoredText.add(b.section_id)
  }
  for (const b of blocks) {
    if (b.kind !== "image" || !b.section_id || !guided.has(b.section_id) || marks.has(b.block_id)) continue
    const tableAuthored = blocks.some((x) => x.section_id === b.section_id && x.kind === "table" && !out.has(x.block_id) && !marks.has(x.block_id))
    if (!authoredText.has(b.section_id) && !tableAuthored) out.add(b.block_id)
  }
  return out
}
