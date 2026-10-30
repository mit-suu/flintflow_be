/**
 * Đo độ chính xác khớp mẫu I-3 (FLF-343). Hai cách dùng:
 * - **CI** (`match-harness.test.ts`): biến thể sinh ở `testing/match-variants.ts` — dương (heading theo style, in đậm, `numPr`,
 *   đổi tên, style riêng, mục lục Word / gõ tay; ≥ 90 % heading vào đúng mục) và âm (gạch đầu dòng in đậm, danh sách khoá<tab>giá
 *   trị, tiêu đề bìa, câu trùng tiêu đề mục lục; không thêm heading, không mất đoạn).
 * - **Báo cáo** (`npm run eval:import-match -- <file.docx>`): file SRS thật — bản đồ heading ⇒ mục, phân bố độ tin, số chỗ
 *   "Cần xem". File thật có thể thiếu / sai nên **không phải đáp án**, chỉ in ra để người đọc xem.
 */

import { MAPPING_CONFIDENCE_THRESHOLD } from "./import.constants.js"
import { parseDocument } from "./parse.service.js"
import { autoConfirmMapping, matchProfile } from "./profile-match.service.js"
import type { HeadingMapEntry } from "./template-profile.model.js"
import { splitHeadingNumber } from "./text-similarity.js"
import { HARNESS_OUTLINE, HARNESS_VARIANTS, NEGATIVE_VARIANTS, buildNegative, buildVariant, type OutlineEntry } from "./testing/match-variants.js"

export { HARNESS_OUTLINE, HARNESS_VARIANTS, NEGATIVE_VARIANTS, buildNegative, buildVariant }

const kindOf = (section: string): string => (section.startsWith("feature:@") ? "feature" : section.startsWith("function:@") ? "function" : section)

const titleKey = (text: string): string => splitHeadingNumber(text).title.toLowerCase().replace(/\s+/g, " ").trim()

export interface VariantScore {
  variant: string
  total: number
  correct: number
  accuracy: number
  /** Heading của dàn mục không được nhận / vào sai mục. */
  misses: { title: string; expected: string; got: string | null }[]
  /** Block nội dung chứa dòng mục lục (phải là 0 — mục lục không bao giờ là nội dung). */
  toc_blocks: number
}

/** Chấm một file theo dàn mục: heading tìm theo tiêu đề (bỏ số), so mục (feature / function so theo loại). */
export const scoreFile = async (buffer: Buffer, variant: string, outline: readonly OutlineEntry[] = HARNESS_OUTLINE, renamed = false): Promise<VariantScore> => {
  const { blocks } = await parseDocument(buffer)
  const { heading_map } = matchProfile(blocks)
  const byTitle = new Map<string, HeadingMapEntry[]>()
  for (const h of heading_map) byTitle.set(titleKey(h.heading_text), [...(byTitle.get(titleKey(h.heading_text)) ?? []), h])
  const misses: VariantScore["misses"] = []
  let correct = 0
  for (const e of outline) {
    const hit = byTitle.get(titleKey(renamed ? e.renamed : e.title))?.shift()
    const got = hit ? kindOf(hit.section_id) : null
    if (got === e.expected) correct++
    else misses.push({ title: renamed ? e.renamed : e.title, expected: e.expected, got })
  }
  const tocBlocks = blocks.filter((b) => b.kind !== "heading" && /(\.{5,}|\t\d+\s*$)/.test(b.text)).length
  return { variant, total: outline.length, correct, accuracy: outline.length ? correct / outline.length : 1, misses, toc_blocks: tocBlocks }
}

/** Biến thể âm: heading thừa (không thuộc dàn mục) và đoạn nhiễu bị mất / bị nhận thành heading. */
export const checkNegative = async (buffer: Buffer, headings: readonly string[], keep: readonly string[]): Promise<{ extra_headings: string[]; dropped: string[] }> => {
  const { blocks } = await parseDocument(buffer)
  const found = blocks.filter((b) => b.kind === "heading").map((b) => b.text.trim())
  const content = new Set(blocks.filter((b) => b.kind !== "heading").map((b) => b.text.trim()))
  return { extra_headings: found.filter((h) => !headings.includes(h)), dropped: keep.filter((k) => !content.has(k)) }
}

/** Chấm mọi biến thể sinh từ dàn mục. */
export const runHarness = async (outline: readonly OutlineEntry[] = HARNESS_OUTLINE): Promise<{ variants: VariantScore[]; accuracy: number }> => {
  const variants: VariantScore[] = []
  for (const v of HARNESS_VARIANTS) variants.push(await scoreFile(await buildVariant(v, outline), v, outline, v === "renamed"))
  const total = variants.reduce((n, v) => n + v.total, 0)
  return { variants, accuracy: total ? variants.reduce((n, v) => n + v.correct, 0) / total : 1 }
}

export interface MatchReport {
  template_family: string
  headings: { block_id: string; level: number | null; heading_text: string; section_id: string; confidence: number; detected_by: string; needs_review: boolean }[]
  /** Số heading theo khoảng độ tin `[0, 0.5)`, `[0.5, 0.8)`, `[0.8, 0.9)`, `[0.9, 1]`. */
  histogram: Record<string, number>
  /** Heading + cột bảng độ tin < 0.8 — chạy thật sẽ thành cờ "Cần xem". */
  needs_review: { headings: number; table_columns: number }
  toc_blocks: number
}

const BUCKETS: readonly [string, number, number][] = [
  ["<0.5", 0, 0.5],
  ["0.5-0.8", 0.5, MAPPING_CONFIDENCE_THRESHOLD],
  ["0.8-0.9", MAPPING_CONFIDENCE_THRESHOLD, 0.9],
  [">=0.9", 0.9, 1.01]
]

/** Báo cáo khớp mẫu của một file thật (không có đáp án — chỉ để đọc). */
export const matchReport = async (buffer: Buffer): Promise<MatchReport> => {
  const { blocks } = await parseDocument(buffer)
  const profile = matchProfile(blocks)
  autoConfirmMapping(profile)
  const levels = new Map(blocks.map((b) => [b.block_id, b.level]))
  const histogram = Object.fromEntries(BUCKETS.map(([k]) => [k, 0]))
  for (const h of profile.heading_map) {
    const bucket = BUCKETS.find(([, lo, hi]) => h.confidence >= lo && h.confidence < hi)
    if (bucket) histogram[bucket[0]]++
  }
  return {
    template_family: profile.template_family,
    headings: profile.heading_map.map((h) => ({
      block_id: h.block_id,
      level: levels.get(h.block_id) ?? null,
      heading_text: h.heading_text,
      section_id: h.section_id,
      confidence: h.confidence,
      detected_by: h.detected_by,
      needs_review: !!h.auto_confirmed
    })),
    histogram,
    needs_review: {
      headings: profile.heading_map.filter((h) => h.auto_confirmed).length,
      table_columns: profile.table_map.filter((t) => t.auto_confirmed && t.field_path).length
    },
    toc_blocks: blocks.filter((b) => b.kind !== "heading" && /(\.{5,}|\t\d+\s*$)/.test(b.text)).length
  }
}
