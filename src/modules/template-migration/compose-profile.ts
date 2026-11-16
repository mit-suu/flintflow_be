/**
 * Dựng phần `TemplateProfile` mô tả file nền mới (heading_map, table_map, layout, template_context, mục thiếu) từ layout dự kiến của
 * lần đổi mẫu và file vừa dựng. Chỉ đọc file — không DB, không AI. Bước áp dụng lưu kết quả lên migration ở bước dựng file và chỉ
 * `$set` nó vào profile ở bước cuối, nên phục hồi chạy tiếp không phải dựng lại.
 */
import { parseDocument } from "../import/parse.service.js"
import { assignBlockSections } from "../import/profile-match.service.js"
import { buildTemplateContext, type TemplateContextEntry } from "../import/template-context.js"
import type { HeadingMapEntry, LayoutEntry, TableMapEntry } from "../import/template-profile.model.js"
import { foldText } from "../import/text-similarity.js"
import type { CustomBlock } from "../spine/spine.types.js"
import type { PlannedLayoutEntry } from "./build-base-file.js"

export interface ComposedProfile {
  heading_map: HeadingMapEntry[]
  table_map: TableMapEntry[]
  layout: LayoutEntry[]
  template_context: TemplateContextEntry[]
  missing_sections: string[]
  warnings: string[]
}

export interface ComposeInput {
  buffer: Buffer
  plan: readonly PlannedLayoutEntry[]
  /** `new_key` của mục thiếu có nội dung (cần BA viết) — chặn phát hành tới khi xong. */
  needsContent: ReadonlySet<string>
  /** Cột đã biết ánh xạ field (mẫu đích + profile cũ): tiêu đề đã gập ⇒ `field_path`. Mẫu đích đứng trước thắng. */
  knownColumns: readonly { header: string; field_path: string | null }[]
}

const GUIDANCE_BRACKETS = (text: string): string => (/^[[{(]/.test(text.trim()) ? text : `[${text}]`)

/** Ghép heading của file với mục layout theo thứ tự; số lượng lệch (writer chèn / bỏ heading) thì ghép tiến theo chữ heading. */
const alignHeadings = <B extends { text: string }>(blocks: readonly B[], plan: readonly PlannedLayoutEntry[]): { pairs: [B, PlannedLayoutEntry][]; exact: boolean } => {
  if (blocks.length === plan.length) return { pairs: blocks.map((b, i) => [b, plan[i]]), exact: true }
  const pairs: [B, PlannedLayoutEntry][] = []
  let at = 0
  for (const entry of plan) {
    const want = foldText(entry.heading_text)
    const found = blocks.findIndex((b, i) => i >= at && foldText(b.text) === want)
    if (found < 0) continue
    pairs.push([blocks[found], entry])
    at = found + 1
  }
  return { pairs, exact: false }
}

export const composeProfile = async (input: ComposeInput): Promise<ComposedProfile> => {
  const { blocks } = await parseDocument(input.buffer)
  const warnings: string[] = []
  const shown = input.plan.filter((e) => e.heading_text.trim())
  const headingBlocks = blocks.filter((b) => b.kind === "heading" && b.level !== null && !b.tail)
  const { pairs, exact } = alignHeadings(headingBlocks, shown)
  if (!exact) warnings.push(`File nền mới có ${headingBlocks.length} heading nhưng layout dự kiến có ${shown.length}: ghép theo chữ heading, ${shown.length - pairs.length} mục chưa gắn được vào file.`)

  const heading_map: HeadingMapEntry[] = pairs.map(([b, e]) => ({
    block_id: b.block_id,
    heading_text: e.heading_text,
    section_id: e.section_id,
    confidence: 1,
    detected_by: "user",
    confirmed: true
  }))

  const missingEntries = input.plan.filter((e) => e.missing && e.new_key !== null && input.needsContent.has(e.new_key))
  const missing_sections = [...new Set(missingEntries.map((e) => e.section_id))]

  const layout: LayoutEntry[] = input.plan.map((e, order) => ({
    order,
    heading_text: e.heading_text,
    level: e.level,
    section_id: e.section_id,
    ...(e.missing && e.guidance ? { template_guidance: [GUIDANCE_BRACKETS(e.guidance)] } : {})
  }))

  const known = new Map<string, string | null>()
  for (const c of input.knownColumns) if (!known.has(foldText(c.header)) || (known.get(foldText(c.header)) === null && c.field_path)) known.set(foldText(c.header), c.field_path)
  const table_map: TableMapEntry[] = blocks
    .filter((b) => b.kind === "table" && b.rows?.length)
    .flatMap((b) =>
      b.rows![0].map((header, column_index) => ({ block_id: b.block_id, column_index, header, field_path: known.get(foldText(header)) ?? null, confidence: 1, confirmed: true }))
    )

  // Ngữ cảnh mẫu cho BA viết mục thiếu: chữ hướng dẫn / ví dụ của mẫu nằm dưới heading của mục
  const missingSet = new Set(missing_sections)
  const sectionOf = assignBlockSections(blocks, heading_map)
  const context: { section_id: string; block: CustomBlock }[] = []
  for (const b of blocks) {
    const section = sectionOf.get(b.block_id)
    if (!section || !missingSet.has(section)) continue
    if (b.kind === "table" && b.rows?.length) context.push({ section_id: section, block: { kind: "table", text: "", rows: b.rows, image_ref: null } })
    else if ((b.kind === "paragraph" || b.kind === "list_item") && b.text.trim()) context.push({ section_id: section, block: { kind: b.kind, text: b.text.trim(), rows: null, image_ref: null } })
  }
  const template_context = buildTemplateContext(layout.filter((l) => missingSet.has(l.section_id)), context)

  return { heading_map, table_map, layout, template_context, missing_sections, warnings }
}
