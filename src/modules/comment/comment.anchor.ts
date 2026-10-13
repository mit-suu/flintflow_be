import type { Block, InlineRun, RenderedDocument } from "../render/rendered-document.types.js"
import { COMMENT_EXCERPT_MAX } from "./comment.model.js"

const runsText = (runs: readonly InlineRun[]): string => runs.map((r) => r.text).join("")

/** Chữ thuần của một block — chỉ để trích đoạn ghim, không dùng để render. */
export const blockText = (block: Block): string => {
  switch (block.type) {
    case "paragraph":
      return runsText(block.runs)
    case "heading":
      return block.text
    case "bullet_list":
    case "numbered_list":
      return block.items.map(runsText).join(" · ")
    case "table":
      return [block.header, ...block.rows].map((row) => row.map(runsText).join(" | ")).join(" / ")
    case "image":
      return block.caption ?? ""
    case "page_break":
      return ""
  }
}

const clip = (text: string): string | null => {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return null
  return flat.length > COMMENT_EXCERPT_MAX ? `${flat.slice(0, COMMENT_EXCERPT_MAX - 1)}…` : flat
}

export interface ResolvedAnchor {
  section_id: string
  block_index: number | null
  label: string
  excerpt: string | null
}

/**
 * Dựng chỗ ghim từ đúng bản đang đọc (UC-49: "The anchor must exist in the version being read"). Nhãn và đoạn trích
 * do server dựng — client chỉ gửi khoá. Không tìm thấy section/block ⇒ `null`.
 */
export const resolveAnchor = (doc: RenderedDocument, sectionId: string, blockIndex: number | null): ResolvedAnchor | null => {
  const section = doc.sections.find((s) => s.id === sectionId)
  if (!section) return null
  const heading = [section.number, section.heading].filter(Boolean).join(" ")
  if (blockIndex === null) {
    return { section_id: sectionId, block_index: null, label: heading, excerpt: clip(section.blocks.map(blockText).join(" ")) }
  }
  const block = section.blocks[blockIndex]
  if (!block) return null
  return { section_id: sectionId, block_index: blockIndex, label: `${heading} › Block ${blockIndex + 1}`, excerpt: clip(blockText(block)) }
}
