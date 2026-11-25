/**
 * Chữ gốc của file import theo mục (`GET /projects/:id/import/source`) — màn đọc file hiện nội dung tài liệu bên cạnh tiến độ.
 * Tải một lần, không đi theo poll: file 200 trang có thể hàng trăm nghìn ký tự. Chỉ đọc `DocBlock`, không gọi AI.
 */

import { createHash } from "node:crypto"
import { IMPORTED_DOC_VERSIONS } from "../doc-version/versioning.js"
import { capitalize, sectionLabel } from "../spine/human-labels.js"
import { DocBlock } from "./doc-block.model.js"
import type { ImportSourceResponse } from "./import.dto.js"
import { latestImport } from "./import.service.js"
import { Mode1Error } from "./mode1.errors.js"
import { tableRows, tableText } from "./table-rows.js"
import { TemplateProfile } from "./template-profile.model.js"

type SourceSection = ImportSourceResponse["sections"][number]

/** Ô / dòng của bảng đã nằm trong chữ của block bảng — không trả riêng. */
const TABLE_PART_KINDS = new Set(["table_row", "table_cell"])

const filterOf = (projectId: string) => ({ projectId, doc_version: { $in: IMPORTED_DOC_VERSIONS } })

/**
 * Khoá cache: bản import + số block + số mục đã tách. Nội dung block chỉ đổi khi import mới (id khác) hoặc file được viết lại
 * (Bỏ chữ trước Bắt đầu — số block đổi).
 */
export const importSourceEtag = async (projectId: string): Promise<{ importId: string; etag: string }> => {
  const doc = await latestImport(projectId)
  if (!doc) throw new Mode1Error("IMPORT_NOT_FOUND", "Không tìm thấy lần import")
  const [blocks, profile] = await Promise.all([DocBlock.countDocuments(filterOf(projectId)), TemplateProfile.findOne({ projectId }, { heading_map: 1 }).lean()])
  const key = `${String(doc._id)}:${blocks}:${profile?.heading_map.length ?? 0}`
  return { importId: String(doc._id), etag: `"${createHash("sha1").update(key).digest("hex").slice(0, 20)}"` }
}

/** Chữ gốc theo mục, đúng thứ tự xuất hiện trong file. Block chưa gắn mục (`section_id` null) không trả. */
export const buildImportSource = async (projectId: string, importId: string): Promise<ImportSourceResponse> => {
  const [blocks, profile] = await Promise.all([
    DocBlock.find(filterOf(projectId)).sort({ "anchor.ordinal": 1 }).select("block_id kind level text rows section_id number_label anchor.xml_path").lean(),
    TemplateProfile.findOne({ projectId }, { heading_map: 1 }).lean()
  ])
  const levelOf = new Map(blocks.map((b) => [b.block_id, b.level ?? 0]))
  const headingOf = new Map<string, { text: string; level: number }>()
  for (const h of profile?.heading_map ?? []) {
    if (headingOf.has(h.section_id)) continue
    const text = [h.number_label, h.heading_text].filter((x) => x && x.trim()).join(" ")
    headingOf.set(h.section_id, { text, level: levelOf.get(h.block_id) ?? 0 })
  }

  const sections = new Map<string, SourceSection>()
  for (const b of blocks) {
    if (!b.section_id || TABLE_PART_KINDS.has(b.kind)) continue
    let section = sections.get(b.section_id)
    if (!section) {
      const heading = headingOf.get(b.section_id)
      section = { section_id: b.section_id, title: heading?.text || capitalize(sectionLabel(b.section_id)), level: heading?.level ?? 0, blocks: [] }
      sections.set(b.section_id, section)
    }
    const text = b.kind === "table" ? tableText(tableRows(b, blocks)) : b.kind === "image" ? "" : b.text
    section.blocks.push({ block_id: b.block_id, kind: b.kind, text })
  }
  return { import_id: importId, sections: [...sections.values()] }
}
