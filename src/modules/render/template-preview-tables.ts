/**
 * FLF-379 — bản xem trước của dự án **mẫu cố định** hiện bảng đúng cột như bản xuất Word.
 *
 * Bản xuất điền vào file mẫu: mỗi bảng FlintFlow được ghép vào cột của bảng mẫu nằm dưới cùng heading (`writeTemplateDocx`
 * → `projectTableColumns`). Bản xem trước trước đây in nguyên cột FlintFlow (vd Tài liệu tham khảo có "Phiên bản / Ngày /
 * Nơi lưu" mà file không có) ⇒ xem một đằng, xuất một nẻo. Ở đây dựng lại đúng phép ghép đó từ khối đã nhập (không tải
 * file mẫu): heading đã map ⇒ các bảng của file nằm dưới heading đó (tới heading kế tiếp) ⇒ bảng thứ i của mục ↔ bảng thứ i
 * của file, như bộ ghi Word.
 */

import { DocBlock } from "../import/doc-block.model.js"
import { TemplateProfile, type TableMapEntry } from "../import/template-profile.model.js"
import { IMPORTED_DOC_VERSIONS } from "../doc-version/versioning.js"
import type { Block, RenderedDocument, RenderedSection } from "./rendered-document.types.js"
import { fitTableToHeaders, projectTableColumns } from "./template-docx-writer.js"

type TableBlock = Extract<Block, { type: "table" }>

export interface SourceBlock {
  block_id: string
  kind: string
  /** Chỉ bảng: chữ từng ô theo hàng như parser đọc. */
  rows?: string[][] | null
}

/** Bảng của file nằm dưới từng heading đã map (theo thứ tự file), tới heading kế tiếp bất kỳ. */
const sourceTablesBySlot = (blocks: readonly SourceBlock[], headingMap: readonly { block_id: string; section_id: string }[]) => {
  const slotOf = new Map(headingMap.map((h) => [h.block_id, h.section_id]))
  const out = new Map<string, SourceBlock[]>()
  let current: string | null = null
  for (const b of blocks) {
    if (b.kind === "heading") {
      current = slotOf.get(b.block_id) ?? null
      if (current && !out.has(current)) out.set(current, [])
      continue
    }
    if (current && b.kind === "table") out.get(current)!.push(b)
  }
  return out
}

/**
 * Thuần: thay bảng của các mục bằng bảng đã ghép cột mẫu; bảng không ghép được giữ nguyên (bộ ghi Word cũng in bảng FlintFlow).
 * Chỉ áp cho bảng có `table_map` (bộ ghi Word cũng chỉ ghép khi bảng mẫu có cột đã nhận diện).
 */
export const projectPreviewTables = (
  doc: RenderedDocument,
  blocks: readonly SourceBlock[],
  headingMap: readonly { block_id: string; section_id: string }[],
  tableMap: readonly TableMapEntry[]
): RenderedDocument => {
  if (!tableMap.length) return doc
  const tablesBySlot = sourceTablesBySlot(blocks, headingMap)
  const used = new Map<string, number>()
  const ancestors: { level: number; slot: string }[] = []
  let changed = false
  const sections = doc.sections.map((section): RenderedSection => {
    while (ancestors.length && ancestors[ancestors.length - 1].level >= section.level) ancestors.pop()
    const slot = tablesBySlot.has(section.id) ? section.id : ancestors[ancestors.length - 1]?.slot
    if (!slot) return section
    ancestors.push({ level: section.level, slot })
    const sources = tablesBySlot.get(slot) ?? []
    let touched = false
    const sectionBlocks = section.blocks.map((block) => {
      if (block.type !== "table") return block
      const index = used.get(slot) ?? 0
      used.set(slot, index + 1)
      const source = sources[index]
      const headers = source?.rows?.[0]
      if (!source || !headers?.length) return block
      const mappings = tableMap.filter((m) => m.block_id === source.block_id)
      try {
        // Như bộ ghi Word: ghép trường theo table_map, rồi đặt vào đúng cột của bảng mẫu
        const projected: TableBlock = fitTableToHeaders(projectTableColumns(block, headers, mappings), headers)
        touched = true
        return projected
      } catch {
        return block
      }
    })
    if (!touched) return section
    changed = true
    return { ...section, blocks: sectionBlocks }
  })
  return changed ? { ...doc, sections } : doc
}

/** Nạp profile + khối đã nhập rồi ghép cột (dự án mẫu cố định). Lỗi nạp ⇒ trả nguyên bản xem trước. */
export const applyTemplatePreviewTables = async (projectId: string, doc: RenderedDocument): Promise<RenderedDocument> => {
  const profile = await TemplateProfile.findOne({ projectId }, { heading_map: 1, table_map: 1 }).sort({ updatedAt: -1 }).lean()
  if (!profile?.table_map?.length) return doc
  const blocks = await DocBlock.find({ projectId, doc_version: { $in: IMPORTED_DOC_VERSIONS }, kind: { $in: ["heading", "table"] } })
    .sort({ "anchor.ordinal": 1 })
    .select("block_id kind rows")
    .lean()
  return projectPreviewTables(doc, blocks as SourceBlock[], profile.heading_map, profile.table_map)
}
