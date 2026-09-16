/**
 * consistency-pass.ts
 * ─────────────────────────────────────────────────────────────────
 * S-8.4 Consistency Pass. Nhánh **tất định** (mặc định, luôn chạy):
 *   - toàn vẹn tham chiếu — dùng lại `reference-fields.ts` (T08), không chép luật.
 *   - số hiệu section trùng nhau trong tài liệu vừa ghép (lỗi lập trình, không nên xảy ra).
 *   - thuật ngữ viết-hoa-toàn-bộ xuất hiện trong văn xuôi nhưng chưa có trong `glossary[]`
 *     (heuristic — cố ý ồn để nhắc rà tay, KHÔNG chặn export, KHÔNG ghi vào đâu).
 *
 * Nhánh **LLM** (trùng lặp ngữ nghĩa, thuật ngữ lệch) chỉ là stub sau flag
 * `CONSISTENCY_LLM_ENABLED` — không gọi model thật ở T15 (điều cấm §3 coding-rules).
 *
 * Hàm ở đây KHÔNG ghi Spine, KHÔNG chặn assemble/export — kết quả chỉ để log/quan sát.
 */

import { findDeadReferences } from "../spine/reference-fields.js"
import type { Spine } from "../spine/spine.types.js"
import type { Block, RenderedSection } from "./rendered-document.types.js"

export type ConsistencyRule = "dead_reference" | "duplicate_section_number" | "undefined_term" | "diagram_png_missing"

export interface ConsistencyFinding {
  rule: ConsistencyRule
  message: string
  path?: string
  section_id?: string
}

/**
 * Sơ đồ `render_status = "ok"` nhưng PNG không tải được lúc assemble: tài liệu dùng ảnh placeholder cho tới
 * khi PNG có (render lại với `force`, hoặc khôi phục file store). Trả qua `meta.consistency` của
 * `POST /assemble` để client biết vì sao thay vì 200 im lặng (assemble.service.ts).
 */
export const missingImageFindings = (diagramIds: readonly string[]): ConsistencyFinding[] =>
  diagramIds.map((id) => ({
    rule: "diagram_png_missing" as const,
    path: `diagrams[id=${id}]`,
    message: `Diagram ${id} has no PNG yet — a placeholder image is used until it is rendered`
  }))

/** `true` chỉ khi biến môi trường được đặt đúng chuỗi — mặc định tắt (S-8.4 nhánh LLM là stub). */
export const CONSISTENCY_LLM_ENABLED = process.env.CONSISTENCY_LLM_ENABLED === "true"

const findDuplicateSectionNumbers = (sections: RenderedSection[]): ConsistencyFinding[] => {
  const counts = new Map<string, number>()
  for (const s of sections) counts.set(s.number, (counts.get(s.number) ?? 0) + 1)
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([number]) => ({ rule: "duplicate_section_number" as const, message: `Section number "${number}" is used by more than one section` }))
}

const plainText = (block: Block): string => {
  switch (block.type) {
    case "paragraph":
      return block.runs.map((r) => r.text).join("")
    case "heading":
      return block.text
    case "bullet_list":
    case "numbered_list":
      return block.items.map((item) => item.map((r) => r.text).join("")).join(" ")
    case "table":
      return [...block.header, ...block.rows.flat()].map((c) => c.map((r) => r.text).join("")).join(" ")
    case "image":
      return block.caption ?? ""
    case "page_break":
      return ""
  }
}

/** Chuỗi in hoa toàn bộ ≥ 2 ký tự chữ — bỏ chuỗi dính chữ số (thường là id thực thể như FN006). */
const ACRONYM = /\b[A-Z]{2,}\b/g

const findUndefinedGlossaryTerms = (spine: Spine, sections: RenderedSection[]): ConsistencyFinding[] => {
  const defined = new Set(spine.glossary.map((g) => g.term.toUpperCase()))
  const firstSeenIn = new Map<string, string>()
  for (const section of sections) {
    for (const block of section.blocks) {
      for (const match of plainText(block).matchAll(ACRONYM)) {
        if (!firstSeenIn.has(match[0])) firstSeenIn.set(match[0], section.id)
      }
    }
  }
  return [...firstSeenIn.entries()]
    .filter(([term]) => !defined.has(term))
    .map(([term, sectionId]) => ({
      rule: "undefined_term" as const,
      message: `Term "${term}" is used in the document but not defined in the glossary`,
      section_id: sectionId
    }))
}

const deterministicChecks = (spine: Spine, sections: RenderedSection[]): ConsistencyFinding[] => [
  ...findDeadReferences(spine).map((hit) => ({
    rule: "dead_reference" as const,
    message: `${hit.refPath} points to a missing ${hit.target} "${hit.targetId}"`,
    path: hit.refPath
  })),
  ...findDuplicateSectionNumbers(sections),
  ...findUndefinedGlossaryTerms(spine, sections)
]

/**
 * Stub nhánh LLM (S-8.4: trùng lặp ngữ nghĩa, thuật ngữ lệch). Không gọi model thật —
 * chỉ tồn tại để `runConsistencyPass` có chỗ cắm khi có PR hiện thực thật kèm skill riêng.
 */
async function llmConsistencyPass(_spine: Spine, _sections: RenderedSection[]): Promise<ConsistencyFinding[]> {
  return []
}

/** S-8.4: chạy nhánh tất định luôn; nhánh LLM chỉ chạy khi `CONSISTENCY_LLM_ENABLED`. */
export async function runConsistencyPass(spine: Spine, sections: RenderedSection[]): Promise<ConsistencyFinding[]> {
  const deterministic = deterministicChecks(spine, sections)
  if (!CONSISTENCY_LLM_ENABLED) return deterministic
  return [...deterministic, ...(await llmConsistencyPass(spine, sections))]
}
