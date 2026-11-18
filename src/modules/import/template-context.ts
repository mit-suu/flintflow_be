/**
 * FLF-378 (luồng C — dự án mới theo mẫu bắt buộc, C2): chữ trong mẫu là **hướng dẫn / ví dụ / ngữ cảnh**, không phải dữ liệu.
 *
 * - Hướng dẫn: chữ trong `[ ]` / `{ }` (luật FLF-364, `splitInstruction`) — mục này cần viết gì.
 * - Ví dụ: chữ ngoài ngoặc **không khớp dự án** — "Ví dụ", "VD:", "e.g.", "Sample", tên chỗ điền ("Nguyễn Văn A", "Hệ thống
 *   XYZ"), dòng mẫu của bảng. Học cấu trúc / văn phong, **không chép**.
 * - Ngữ cảnh: chữ ngoài ngoặc **khớp dự án** (đúng tên hệ thống, quy định của khách) — thông tin nền, không phải nội dung đã chốt.
 *
 * Lúc import (chưa có thông tin dự án) chỉ chạy luật tất định: `example` khi có dấu hiệu ví dụ / dòng mẫu bảng, còn lại
 * `unclassified`. Lúc soạn (Brief, bước S-x) `classifyPassages` so đoạn `unclassified` với thông tin dự án ⇒ `context` /
 * `example`. Hàm thuần — không đọc DB.
 */

import { splitInstruction } from "../../shared/utils/instruction-text.js"
import type { CustomBlock } from "../spine/spine.types.js"
import type { LayoutEntry } from "./template-profile.model.js"

export type TemplatePassageKind = "example" | "context" | "unclassified"

export interface TemplatePassage {
  text: string
  kind: TemplatePassageKind
}

export interface TemplateContextEntry {
  /** Mục của layout (`fixed:*`, `slot:*`, `custom:*`…). */
  section_id: string
  /** Heading của mẫu (nguyên văn). */
  heading: string
  /** Chữ hướng dẫn (bỏ ngoặc). */
  guidance: string[]
  /** Đoạn ngoài ngoặc + dòng mẫu của bảng. */
  passages: TemplatePassage[]
  /** Hàng tiêu đề của từng bảng mẫu trong mục. */
  table_columns: string[][]
}

/** Trần chữ mỗi mục — mẫu dài không làm phình prompt. */
export const MAX_PASSAGES_PER_SECTION = 12
const MAX_PASSAGE_CHARS = 600

const EXAMPLE_MARKERS: readonly RegExp[] = [
  /^\s*(ví dụ|vi du|vd|e\.\s?g\.?|eg|example|examples|for example|sample|mẫu)\s*[:.\-–)]/i,
  /\b(ví dụ|for example|for instance|e\.g\.|such as:)/i,
  /\b(nguyễn văn a|nguyen van a|trần thị b|john doe|jane doe|lorem ipsum|acme)\b/i,
  /\b(hệ thống|system|công ty|company|dự án|project)\s+(xyz|abc|x)\b/i,
  /\b(xxx|yyy|n\/a)\b/i
]

/** Đoạn có dấu hiệu ví dụ / chỗ điền (luật tất định, chưa cần thông tin dự án). */
export const looksLikeExample = (text: string): boolean => EXAMPLE_MARKERS.some((re) => re.test(text))

const clip = (text: string): string => (text.length > MAX_PASSAGE_CHARS ? `${text.slice(0, MAX_PASSAGE_CHARS - 1).trimEnd()}…` : text)

/** Ngữ cảnh mẫu theo mục, đúng thứ tự layout; mục không có heading (phần nối) / nhóm bao không có chữ ⇒ bỏ. */
export const buildTemplateContext = (layout: readonly LayoutEntry[], blocks: readonly { section_id: string; block: CustomBlock }[]): TemplateContextEntry[] => {
  const bySection = new Map<string, CustomBlock[]>()
  for (const { section_id, block } of blocks) bySection.set(section_id, [...(bySection.get(section_id) ?? []), block])
  const out: TemplateContextEntry[] = []
  const seen = new Set<string>()
  for (const entry of [...layout].sort((a, b) => a.order - b.order)) {
    if (!entry.heading_text.trim() || seen.has(entry.section_id)) continue
    seen.add(entry.section_id)
    const guidance: string[] = []
    const passages: TemplatePassage[] = []
    const tableColumns: string[][] = []
    for (const block of bySection.get(entry.section_id) ?? []) {
      if (block.kind === "image") continue
      if (block.kind === "table") {
        const rows = (block.rows ?? []).map((r) => r.map((c) => c.trim()))
        if (!rows.length) continue
        tableColumns.push(rows[0])
        // Dòng dưới hàng tiêu đề của bảng mẫu = dòng mẫu (ví dụ); ô trong ngoặc là hướng dẫn
        for (const row of rows.slice(1)) {
          const cells = row.map((c) => splitInstruction(c))
          guidance.push(...cells.flatMap((c) => c.guidance))
          const text = cells.map((c) => c.text).filter(Boolean).join(" | ")
          if (text) passages.push({ text: clip(text), kind: "example" })
        }
        continue
      }
      const split = splitInstruction(block.text)
      guidance.push(...split.guidance)
      if (split.text) passages.push({ text: clip(split.text), kind: looksLikeExample(split.text) ? "example" : "unclassified" })
    }
    // Hướng dẫn trọn đoạn dưới mục FPT nằm ở layout entry (FLF-364)
    for (const g of entry.template_guidance ?? []) guidance.push(...splitInstruction(g).guidance)
    out.push({
      section_id: entry.section_id,
      heading: entry.heading_text.trim(),
      guidance: [...new Set(guidance.filter(Boolean))],
      passages: passages.slice(0, MAX_PASSAGES_PER_SECTION),
      table_columns: tableColumns
    })
  }
  return out
}

// ─── so với thông tin dự án (Brief / bước S-x) ─────────────────────

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "are", "will", "can", "của", "và", "các", "những", "cho", "với", "được", "là",
  "một", "trong", "này", "khi", "để", "có", "không", "theo"
])

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const wordsOf = (text: string): string[] => normalize(text).split(" ").filter((w) => w.length > 1 && !STOP_WORDS.has(w))

/** Cụm hai từ liền nhau — tiếng Việt từ đơn quá chung ("quản", "lý"), cụm mới mang nghĩa ("quan ly kho"). */
const bigramsOf = (text: string): Set<string> => {
  const w = wordsOf(text)
  return new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`))
}

export interface ProjectFacts {
  /** Tên dự án / hệ thống. */
  name?: string | null
  /** Mô tả, ý tưởng, tầm nhìn, lĩnh vực… */
  texts?: readonly (string | null | undefined)[]
}

/**
 * Xếp đoạn `unclassified` theo thông tin dự án: nhắc đúng tên dự án hoặc trùng ≥ 2 cụm từ với mô tả dự án ⇒ `context`; còn
 * lại ⇒ `example` (chữ của mẫu nói về hệ thống khác). Chưa có thông tin dự án ⇒ giữ `unclassified`. Đoạn đã có nhãn giữ nguyên.
 */
export const classifyPassages = (passages: readonly TemplatePassage[], facts: ProjectFacts): TemplatePassage[] => {
  const name = normalize(facts.name ?? "")
  const projectBigrams = new Set([...bigramsOf(facts.name ?? ""), ...(facts.texts ?? []).flatMap((t) => [...bigramsOf(t ?? "")])])
  if (!name && projectBigrams.size === 0) return passages.map((p) => ({ ...p }))
  return passages.map((p) => {
    if (p.kind !== "unclassified") return { ...p }
    const text = normalize(p.text)
    if (name.length >= 3 && ` ${text} `.includes(` ${name} `)) return { ...p, kind: "context" }
    const shared = [...bigramsOf(p.text)].filter((b) => projectBigrams.has(b)).length
    return { ...p, kind: shared >= 2 ? "context" : "example" }
  })
}

/**
 * Khối prompt cho các mục mẫu một bước soạn (C2.3): hướng dẫn, ví dụ (không chép), ngữ cảnh, cột bảng mẫu, "nội dung nên có"
 * (ISO 29148). Rỗng ⇒ "".
 */
export const templatePromptBlock = (
  entries: readonly TemplateContextEntry[],
  facts: ProjectFacts,
  shouldContain: (sectionId: string) => string | null = () => null
): string => {
  const parts: string[] = []
  for (const e of entries) {
    const passages = classifyPassages(e.passages, facts)
    const lines: string[] = [`### Template section: ${e.heading}`]
    const hint = shouldContain(e.section_id)
    if (hint) lines.push(`Should contain (ISO/IEC/IEEE 29148): ${hint}`)
    if (e.guidance.length) lines.push("Template guidance:", ...e.guidance.map((g) => `- ${g}`))
    const examples = passages.filter((p) => p.kind === "example")
    const context = passages.filter((p) => p.kind === "context")
    const unknown = passages.filter((p) => p.kind === "unclassified")
    if (examples.length) lines.push("Template example (style and structure only - DO NOT copy names, data or sentences):", ...examples.map((p) => `- ${p.text}`))
    if (context.length) lines.push("Template context (customer background for this project - use as facts, rewrite in the document's voice):", ...context.map((p) => `- ${p.text}`))
    if (unknown.length) lines.push("Template text (unclassified - use only if it matches this project, otherwise treat as an example):", ...unknown.map((p) => `- ${p.text}`))
    if (e.table_columns.length) lines.push("Template table columns (keep these columns and their order):", ...e.table_columns.map((c) => `- ${c.join(" | ")}`))
    if (lines.length > 1) parts.push(lines.join("\n"))
  }
  if (!parts.length) return ""
  return [
    "## Customer template (required layout)",
    "The customer requires this template. Draft every section below for THIS project. Follow the guidance; never copy example text into the document.",
    "Sections of the template that are not listed here were already written by the customer: do not rewrite or remove their content.",
    ...parts
  ].join("\n\n")
}
