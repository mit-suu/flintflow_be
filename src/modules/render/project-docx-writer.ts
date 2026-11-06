import { ApiError } from "../../shared/utils/api-error.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { ImportedDocument } from "../import/imported-document.model.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { Project } from "../project/project.model.js"
import type { TemplateIntent } from "../project/project.model.js"
import { writeDocx, type WriteDocxOptions } from "./docx-writer.js"
import type { RenderedDocument } from "./rendered-document.types.js"
import { writeTemplateDocx } from "./template-docx-writer.js"
import type { HeadingMapEntry, LayoutEntry } from "../import/template-profile.model.js"
import { createHash } from "node:crypto"
import { parseDocument } from "../import/parse.service.js"
import { bindFixedTemplateHeadings } from "../import/content-slots.js"
import { repairFixedTemplateLayout, type TemplateLayout } from "./layout-sections.js"
import { templateLayoutFromBinding, type TemplateSourceBinding } from "../doc-version/template-source-binding.js"
import { DocxPackage, addDraftWatermark } from "../docx-ooxml/index.js"

const unavailable = () => new ApiError(
  409,
  "Chưa tìm thấy file mẫu gốc để giữ đúng định dạng. Vui lòng tải lại mẫu trước khi xuất tài liệu.",
  "TEMPLATE_LAYOUT_UNAVAILABLE"
)

/** buildLayout cấp custom:* cho heading chưa map/lặp; dùng id cuối cùng của layout để điền đúng chỗ. */
export const templateHeadingMap = (
  headings: readonly Pick<HeadingMapEntry, "block_id" | "heading_text" | "section_id">[],
  layout: readonly LayoutEntry[]
): { block_id: string; section_id: string }[] => {
  const mapped = headings.map((h) => ({ block_id: h.block_id, section_id: h.section_id }))
  const used = new Set<number>()
  for (const entry of [...layout].sort((a, b) => a.order - b.order)) {
    if (!entry.heading_text.trim()) continue // phần nối đã được assemble gộp vào mục cha
    const index = headings.findIndex((h, i) => !used.has(i) && h.heading_text.trim() === entry.heading_text.trim())
    if (index < 0) throw unavailable()
    mapped[index].section_id = entry.section_id
    used.add(index)
  }
  return mapped
}

const isTemplateContext = (source: unknown): source is FixedTemplateContext =>
  !!source && typeof source === "object" && Buffer.isBuffer((source as { template?: unknown }).template)

/**
 * Cùng một đường xuất cho Word, PDF và file version: mẫu bắt buộc luôn lấy DOCX upload làm nền. FLF-377: bên gọi đã nạp
 * `loadFixedTemplateContext` (dựng tài liệu cần layout của mẫu) thì truyền nguyên context — không tải lại file mẫu.
 */
export const writeProjectDocx = async (
  doc: RenderedDocument,
  options: WriteDocxOptions = {},
  templateIntent?: TemplateIntent | null,
  source?: TemplateSourceBinding | FixedTemplateContext | null
): Promise<Buffer> => {
  const intent = templateIntent === undefined
    ? (await Project.findById(doc.projectId, { template_intent: 1 }).lean())?.template_intent
    : templateIntent
  if (intent !== "fixed") return writeDocx(doc, options)

  const context = isTemplateContext(source) ? source : await loadFixedTemplateContext(doc.projectId, source)
  const filled = await writeTemplateDocx(doc, context.template, context.headingMap, context.binding.table_map)
  // Bản làm việc vẫn mang watermark DRAFT như mẫu FPT (cùng điều kiện `writeDocx`): chỉ thêm shape chữ mờ vào header — header
  // có sẵn của mẫu giữ nguyên nội dung, mẫu không có header thì thêm một header chỉ chứa watermark. Bản baseline không đổi.
  if (doc.source !== "draft" && doc.watermark !== "DRAFT") return filled
  const pkg = await DocxPackage.load(filled)
  await addDraftWatermark(pkg)
  return pkg.toBuffer()
}

export interface FixedTemplateContext {
  template: Buffer
  binding: TemplateSourceBinding
  layout: TemplateLayout
  headingMap: { block_id: string; section_id: string }[]
}

/** Repair legacy heading/layout omissions from the retained source before assembly, never from cached rendered text. */
export const loadFixedTemplateContext = async (projectId: string, sourceBinding?: TemplateSourceBinding | null): Promise<FixedTemplateContext> => {
  if (sourceBinding === null) throw unavailable()
  const profile = sourceBinding ?? await TemplateProfile.findOne({ projectId }).lean()
  if (!profile?.layout?.length || !profile.heading_map?.length) throw unavailable()
  let ref = profile.source_file_ref
  let recoveredTemplate: Buffer | undefined
  // Legacy profiles: prove the source by its raw hash AND every recorded heading anchor.
  // Multiple different matching sources are ambiguous; never pick the latest upload.
  if (!ref) {
    const imports = await ImportedDocument.find({
      projectId,
      file_ref: { $ne: null },
      "preflight.status": "accepted",
      status: { $in: ["baselining", "incomplete", "drafting", "checking", "gap_review", "delivered", "change_requested"] }
    }, { file_ref: 1, sha256: 1 }).lean()
    const matches = new Map<string, { ref: string; data: Buffer }>()
    for (const imported of imports) {
      if (!imported.file_ref) continue
      try {
        const data = await docFileStore().load(imported.file_ref)
        const hash = createHash("sha256").update(data).digest("hex")
        if (imported.sha256 !== hash) continue
        const { blocks } = await parseDocument(data)
        if (!profile.heading_map.every((h) => blocks.some((b) => b.kind === "heading" && b.block_id === h.block_id && b.text.trim() === h.heading_text.trim()))) continue
        matches.set(hash, { ref: imported.file_ref, data })
      } catch { /* Invalid candidates cannot be the source authority. */ }
    }
    if (matches.size !== 1) throw unavailable()
    const [match] = matches.values()
    ref = match.ref
    recoveredTemplate = match.data
  }
  if (!ref) throw unavailable()
  let template: Buffer
  try {
    template = recoveredTemplate ?? await docFileStore().load(ref)
  } catch {
    throw unavailable()
  }
  const sha = createHash("sha256").update(template).digest("hex")
  if (profile.source_sha256 && profile.source_sha256 !== sha) throw unavailable()
  const parsed = await parseDocument(template)
  const sourceHeadings = parsed.blocks.filter((b) => b.kind === "heading")
  const entries = sourceHeadings.map((heading) => {
    const mapped = profile.heading_map.find((h) => h.block_id === heading.block_id && h.heading_text.trim() === heading.text.trim())
    if (!mapped) throw unavailable()
    return { ...mapped, heading_text: heading.text, level: heading.level ?? 1 }
  })
  const bound = bindFixedTemplateHeadings(entries)
  const repaired = repairFixedTemplateLayout(profile.layout, bound)
  const binding = { ...profile, source_file_ref: ref, source_sha256: sha, layout: repaired } as TemplateSourceBinding
  return {
    template, binding, layout: templateLayoutFromBinding(binding),
    headingMap: templateHeadingMap(bound, repaired)
  }
}
