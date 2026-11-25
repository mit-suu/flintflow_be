/**
 * structure-preview.ts — business-flow §3.1.2 "Màn đọc khung" (bước 1.4 tổng quan).
 *
 * Ngay sau khi tách file + khớp mẫu (tất định, không gọi AI), Code tính **cấu trúc đích sơ bộ** bằng đúng các hàm finalize
 * dùng ở I-5 (`buildLayout`, `sectionsWithContent`, `compareTargetStructure`) trên Spine chưa trích gì: người dùng xem bản đồ
 * mục theo thứ tự file trước khi bấm Bắt đầu (trước khi tốn credit).
 *
 * `kind` phân biệt **khung mẫu** (dưới 20% mục có nội dung) với **SRS đã viết** — chỉ để gắn nhãn câu tóm tắt (FLF-463): mục đã
 * viết luôn là "có", không soạn lại mọi mục vì nhãn này. Sau I-5 cuối, mục nào đổi
 * trạng thái so với bản sơ bộ được ghi lại (`structureChanges`) để workspace báo người dùng — không dừng hỏi lại.
 */

import type { Spine } from "../spine/spine.types.js"
import type { LayoutEntry } from "./template-profile.model.js"
import {
  buildLayout,
  customSectionsWithContent,
  repeatSectionsWithContent,
  sectionsWithContent,
  type LayoutBlock
} from "./step-plan.js"
import { looksLikeExample } from "./template-context.js"
import { sampleBlockIds, stripTemplateMarks } from "./template-markers.js"
import { compareTargetStructure, isNonDraftHeading, type ResolvedMode, type TargetSectionStatus, type TargetStructure, type TemplateIntent } from "./target-structure.js"

export type FileKind = "written" | "template"

/** Dưới tỉ lệ này (mục có nội dung / mục của file) file là khung mẫu, không phải SRS đã viết. */
export const TEMPLATE_CONTENT_RATIO = 0.2

export interface PreviewSection {
  section_id: string
  title: string
  status: TargetSectionStatus
  /** Thứ tự heading trong file; mục của mẫu chuẩn mà file không có xếp sau cùng. */
  order: number
  /**
   * P09 (#15): trích đoạn chữ khách viết dưới mục (≤ `EXCERPT_MAX` ký tự, bỏ hướng dẫn / ví dụ / bảng hình mẫu) — màn đọc khung cho xem
   * FlintFlow đọc được gì ở mỗi mục. Mục không có chữ / còn trống ⇒ không có.
   */
  excerpt?: string
}

/** Độ dài tối đa của trích đoạn một mục (kể cả dấu "…"). */
export const EXCERPT_MAX = 200

export interface StructurePreview {
  summary: { present: number; missing: number; out_of_scope: number; kind: FileKind }
  sections: PreviewSection[]
  resolved_mode: ResolvedMode
  intent: TemplateIntent
  computed_at: string
}

export interface StructureChange {
  section_id: string
  title: string
  from: TargetSectionStatus | "absent"
  to: TargetSectionStatus | "absent"
}

/** Heading của file được tính vào tỉ lệ nội dung: bỏ nhóm bao, phần nối tiêu đề rỗng, bìa / mục lục / Record of Changes. */
const countedHeadings = (layout: readonly LayoutEntry[]): LayoutEntry[] => {
  const seen = new Set<string>()
  return layout.filter((l) => {
    if (l.section_id.startsWith("group:") || seen.has(l.section_id)) return false
    if (!l.heading_text.trim() || isNonDraftHeading(l.section_id, l.heading_text)) return false
    seen.add(l.section_id)
    return true
  })
}

const isExampleText = (b: { kind: string; text: string }): boolean => (b.kind === "paragraph" || b.kind === "list_item") && looksLikeExample(b.text)

/**
 * FLF-382 (khoảng trống FLF-388): mục **khách viết thật** — như mục có nội dung nhưng đoạn có dấu hiệu ví dụ / chỗ điền ("e.g.",
 * "Ví dụ:", "Nguyễn Văn A", "Hệ thống XYZ" — `looksLikeExample`) không tính. Mẫu mà mục nào cũng có câu ví dụ vẫn là khung mẫu.
 * FLF-411: bỏ thêm chữ của mẫu (`stripTemplateMarks` — khoảng `[ … ]` nhiều đoạn, `<<Sample … >>`, chỗ điền) và bảng / hình mẫu ở
 * mục có hướng dẫn (`sampleBlockIds`) — template FPT Capstone trống trước đây ra "SRS đã viết · 16/21".
 */
export const authoredSections = (blocks: readonly LayoutBlock[], headingSections: ReadonlyMap<string, string>): Set<string> => {
  const samples = sampleBlockIds(blocks)
  const real = stripTemplateMarks(blocks).filter((b) => !isExampleText(b) && !samples.has(b.block_id))
  const { customSections, slices } = buildLayout(real, headingSections)
  return contentSections(real, customSections, slices)
}

const contentSections = (
  blocks: readonly LayoutBlock[],
  customSections: Parameters<typeof customSectionsWithContent>[0],
  slices: Parameters<typeof repeatSectionsWithContent>[0]
): Set<string> => new Set([...sectionsWithContent([...blocks]), ...customSectionsWithContent(customSections), ...repeatSectionsWithContent(slices, [...blocks])])

/** Hàm thuần: khung mẫu khi tỉ lệ mục có nội dung dưới `TEMPLATE_CONTENT_RATIO` (file không có heading nào ⇒ khung mẫu). */
export const fileKindOf = (layout: readonly LayoutEntry[], withContent: ReadonlySet<string>): FileKind => {
  const headings = countedHeadings(layout)
  if (!headings.length) return "template"
  const filled = headings.filter((l) => withContent.has(l.section_id)).length
  return filled / headings.length < TEMPLATE_CONTENT_RATIO ? "template" : "written"
}

/** Chữ của một khối cho trích đoạn: bảng ⇒ các dòng (bỏ ô trống) nối bằng " · "; ảnh ⇒ không có chữ. */
const blockText = (b: { kind: string; text: string; rows: string[][] | null }): string =>
  b.kind === "table" ? (b.rows ?? []).map((r) => r.map((c) => c.trim()).filter(Boolean).join(" · ")).filter(Boolean).join("; ") : b.kind === "image" ? "" : b.text

/** Hàm thuần: gộp chữ các khối thành trích đoạn ≤ `EXCERPT_MAX` ký tự (cắt thì thêm "…"). Rỗng ⇒ `undefined`. */
export const excerptOf = (texts: readonly string[]): string | undefined => {
  const text = texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ")
  if (!text) return undefined
  return text.length <= EXCERPT_MAX ? text : `${text.slice(0, EXCERPT_MAX - 1).trimEnd()}…`
}

/** Hàm thuần: bản đồ mục theo thứ tự file + đếm. `excerpts`: trích đoạn theo mục (P09). */
export const toPreview = (
  structure: TargetStructure,
  layout: readonly LayoutEntry[],
  kind: FileKind,
  at: string,
  excerpts: ReadonlyMap<string, string> = new Map()
): StructurePreview => {
  const orderOf = new Map<string, number>()
  for (const l of layout) if (!orderOf.has(l.section_id)) orderOf.set(l.section_id, l.order)
  const sections = structure.sections
    .map((s, i) => ({ s, i, order: orderOf.get(s.section_id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.order - b.order || a.i - b.i)
    .map(({ s, order }, i) => {
      // Mục "Còn trống" không có trích đoạn: chữ dưới nó (nếu có) là hướng dẫn / ví dụ của mẫu, không phải nội dung
      const excerpt = s.status === "missing" ? undefined : excerpts.get(s.section_id)
      return { section_id: s.section_id, title: s.title, status: s.status, order: order === Number.MAX_SAFE_INTEGER ? layout.length + i : order, ...(excerpt ? { excerpt } : {}) }
    })
  const count = (status: TargetSectionStatus) => sections.filter((s) => s.status === status).length
  return {
    summary: { present: count("present"), missing: count("missing"), out_of_scope: count("out_of_scope"), kind },
    sections,
    resolved_mode: structure.resolved_mode,
    intent: structure.intent,
    computed_at: at
  }
}

/**
 * Hàm thuần: cấu trúc đích sơ bộ từ khối vừa tách + bảng heading → mục (id tạm của mapping). Không có khối nào được trích ⇒
 * mục có nội dung chỉ xét chữ thật trong file, như I-5 với phần không trích được.
 */
export const previewStructure = (
  blocks: LayoutBlock[],
  headingSections: ReadonlyMap<string, string>,
  spine: Spine,
  intent: TemplateIntent,
  at: string = new Date().toISOString()
): StructurePreview => {
  const { layout, sectionBlocks } = buildLayout(blocks, headingSections)
  // FLF-411: mục chỉ có chữ của mẫu (hướng dẫn nhiều đoạn, `<<Sample … >>`, chỗ điền) là "Còn trống" — như I-5
  const stripped = stripTemplateMarks(blocks)
  const { customSections, slices } = buildLayout(stripped, headingSections)
  const withContent = contentSections(stripped, customSections, slices)
  const kind = fileKindOf(layout, authoredSections(blocks, headingSections))
  const structure = compareTargetStructure(layout, withContent, spine, intent, at)
  return toPreview(structure, layout, kind, at, excerptsOf(blocks, sectionBlocks))
}

/**
 * P09 (#15): trích đoạn theo mục — chỉ chữ khách viết: bỏ chữ của mẫu (`stripTemplateMarks`), bảng / hình mẫu (`sampleBlockIds`),
 * câu ví dụ (`looksLikeExample`). Mục id theo đúng layout của bản sơ bộ.
 */
const excerptsOf = (blocks: readonly LayoutBlock[], sectionBlocks: ReturnType<typeof buildLayout>["sectionBlocks"]): Map<string, string> => {
  const samples = sampleBlockIds(blocks)
  const real = new Map(stripTemplateMarks(blocks).filter((b) => !isExampleText(b) && !samples.has(b.block_id)).map((b) => [b.block_id, b]))
  const texts = new Map<string, string[]>()
  for (const { section_id, block_id } of sectionBlocks) {
    const b = real.get(block_id)
    if (!b) continue
    const text = blockText({ kind: b.kind, text: b.text, rows: b.rows ?? null })
    if (text.trim()) texts.set(section_id, [...(texts.get(section_id) ?? []), text])
  }
  const out = new Map<string, string>()
  for (const [id, list] of texts) {
    const excerpt = excerptOf(list)
    if (excerpt) out.set(id, excerpt)
  }
  return out
}

/**
 * Hàm thuần: mục đổi trạng thái giữa bản sơ bộ và kết quả I-5 cuối (vd đoạn tưởng nội dung hoá ra chỉ là hướng dẫn).
 * `realId` đổi id tạm của mapping (tính năng / chức năng) sang id thật sau finalize. Rỗng ⇒ khớp.
 */
export const structureChanges = (preview: StructurePreview, final: TargetStructure, realId: (id: string) => string = (id) => id): StructureChange[] => {
  // Mục riêng (`custom:CSnn`) đánh số theo thứ tự tạo — finalize sinh thêm phần nối cho khối không trích được nên số lệch
  // với bản sơ bộ; khớp theo tiêu đề (+ lần xuất hiện) thay vì id
  const keyed = <T extends { section_id: string; title: string }>(sections: readonly T[], toId: (id: string) => string) => {
    const seen = new Map<string, number>()
    return new Map(
      sections.map((s) => {
        if (!s.section_id.startsWith("custom:")) return [toId(s.section_id), s] as const
        const n = (seen.get(s.title) ?? 0) + 1
        seen.set(s.title, n)
        return [`custom-title:${s.title}#${n}`, s] as const
      })
    )
  }
  const before = keyed(preview.sections, realId)
  const after = keyed(final.sections, (id) => id)
  const changes: StructureChange[] = []
  // Chỉ báo mục ảnh hưởng việc soạn (có ↔ còn trống); mục ngoài phạm vi / phần nối không tiêu đề xuất hiện thêm ở bản cuối là nhiễu
  const relevant = (c: StructureChange) => [c.from, c.to].some((st) => st === "present" || st === "missing")
  for (const [key, s] of after) {
    const from = before.get(key)?.status ?? "absent"
    const change: StructureChange = { section_id: s.section_id, title: s.title, from, to: s.status }
    if (from !== s.status && relevant(change)) changes.push(change)
  }
  for (const [key, s] of before) {
    const change: StructureChange = { section_id: realId(s.section_id), title: s.title, from: s.status, to: "absent" }
    if (!after.has(key) && relevant(change)) changes.push(change)
  }
  return changes
}

interface TemplateFileProject {
  start_kind?: string | null
  template_intent?: string | null
}

/**
 * Hàm thuần: file của dự án là **khung mẫu để điền** (giữ khung `fixed` + phần lớn mục trống) — chữ trong file là hướng dẫn /
 * ví dụ, không phải dữ liệu: không trích nội dung, FlintFlow soạn đủ mọi mục (`draftAll`). Hồ sơ trước màn đọc khung không có
 * `structure_preview` ⇒ theo cách cũ (dự án mới có mẫu bắt buộc).
 */
export const isTemplateFile = (project: TemplateFileProject | null, profile: { structure_preview?: StructurePreview | null } | null): boolean => {
  if (project?.template_intent !== "fixed") return false
  const kind = profile?.structure_preview?.summary.kind
  return kind ? kind === "template" : project.start_kind === "new"
}

/**
 * FLF-411: màn đọc khung thấy file là **khung mẫu** (chữ là hướng dẫn / ví dụ), bất kể người dùng có tick "Bổ sung các mục còn
 * thiếu theo mẫu chuẩn FlintFlow" hay không — chữ / hình ví dụ của mẫu không bao giờ là dữ liệu dự án (không trích, không gọi AI).
 * Cách soạn tiếp vẫn theo `isTemplateFile` (giữ khung ⇒ luồng C).
 */
export const isTemplateContent = (profile: { structure_preview?: StructurePreview | null } | null): boolean => profile?.structure_preview?.summary.kind === "template"
