/**
 * FLF-382 (luồng B — có sẵn · mẫu cố định): I-5 sau bản gốc. Hàm `compareTargetStructure` (thuần) cần tập mục "có chữ thật
 * trong file" — sau 0.1 file không đổi, nên tập đó = mục đã `present` lần so trước ∪ mục riêng (`custom:*`) nay có khối thật
 * trong Spine. Mục FPT / phần nhỏ được soạn qua CR có dữ liệu Spine ⇒ `sectionHasData` / `slotHasData` nhận ra.
 */

import { SECTION_FILL_ARRAYS } from "../change-request/spine-location.js"
import { Project } from "../project/project.model.js"
import { sectionHasData } from "../spine/deterministic-check.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { stripRecord } from "./check.service.js"
import { contentSlot } from "./content-slots.js"
import { displayHeading } from "./heading-label.js"
import { sectionTitle } from "./section-catalog.js"
import { customSectionsWithContent } from "./step-plan.js"
import { compareTargetStructure, type TargetStructure } from "./target-structure.js"
import { TemplateProfile, type LayoutEntry } from "./template-profile.model.js"

/** Luồng B: dự án "Upload SRS có sẵn" theo mẫu cố định. */
export const isFixedExisting = (project: { start_kind?: string | null; template_intent?: string | null } | null | undefined): boolean =>
  project?.start_kind === "existing" && project?.template_intent === "fixed"

export const isFixedExistingProject = async (projectId: string): Promise<boolean> =>
  isFixedExisting(await Project.findById(projectId, { start_kind: 1, template_intent: 1 }).lean())

/**
 * Finalize (chế độ 3, người dùng đã bấm "Hoàn thiện", còn mục thiếu) của luồng B ⇒ mục thiếu cần CR bổ sung
 * (`ImportedDocument.gap_fill_requested`). Dự án khác / không còn mục thiếu ⇒ `null`.
 */
export const gapFillRequestOf = (
  project: { start_kind?: string | null; template_intent?: string | null } | null | undefined,
  completeRequested: boolean,
  structure: Pick<TargetStructure, "missing" | "resolved_mode">,
  at: Date = new Date()
): { section_ids: string[]; at: Date } | null =>
  isFixedExisting(project) && completeRequested && structure.resolved_mode === 3 && structure.missing.length > 0 ? { section_ids: [...structure.missing], at } : null

/** Mục FPT không có trong `SECTION_HAS_DATA` mà mảng nuôi mục (`SECTION_FILL_ARRAYS`) đã có phần tử. */
export const fixedSectionArrayFilled = (spine: Spine, sectionId: string): boolean => {
  if (!sectionId.startsWith("fixed:") || sectionHasData(spine, sectionId) !== null) return false
  return (SECTION_FILL_ARRAYS[sectionId] ?? []).some((arr) => {
    const value = (spine as unknown as Record<string, unknown>)[arr]
    return Array.isArray(value) && value.length > 0
  })
}

/** So lại cấu trúc đích trên Spine hiện tại (thuần): mục đã có chữ trong file giữ `present`. */
export const recompareTargetStructure = (prev: TargetStructure, layout: readonly LayoutEntry[], spine: Spine, at: string = new Date().toISOString()): TargetStructure => {
  const withContent = new Set([
    ...prev.sections.filter((s) => s.status === "present").map((s) => s.section_id),
    ...customSectionsWithContent(spine.custom_sections),
    // Mục FPT ngoài bảng kiểm tất định (vd `fixed:5.5` Glossary) nhưng có mảng nuôi đã có phần tử
    ...layout.map((l) => l.section_id).filter((id) => fixedSectionArrayFilled(spine, id))
  ])
  return compareTargetStructure(layout, withContent, spine, prev.intent, at)
}

/** Chạy lại I-5 và lưu `TemplateProfile.target_structure`. Chưa từng so (không có profile / layout) ⇒ `null`, không ghi gì. */
export const refreshTargetStructure = async (projectId: string): Promise<TargetStructure | null> => {
  const profile = await TemplateProfile.findOne({ projectId })
  const prev = profile?.target_structure ?? null
  if (!profile || !prev || !profile.layout?.length) return null
  const record = await spineRepository.get(projectId)
  if (!record) return null
  const next = recompareTargetStructure(prev, profile.layout, stripRecord(record))
  profile.target_structure = next
  profile.markModified("target_structure")
  await profile.save()
  return next
}

/** Tiêu đề mục theo file của khách: I-5 ⇒ heading của layout ⇒ nhãn phần nhỏ / tên mục mẫu (không có ⇒ `""`). */
export const fileSectionTitle = (sectionId: string, structure: Pick<TargetStructure, "sections"> | null | undefined, layout: readonly LayoutEntry[] | null | undefined): string => {
  const fromStructure = structure?.sections.find((s) => s.section_id === sectionId)?.title?.trim()
  if (fromStructure) return fromStructure
  const entry = layout?.find((l) => l.section_id === sectionId && l.heading_text.trim())
  if (entry) return displayHeading(entry.heading_text, entry.number_label)
  // Không bao giờ trả mã nội bộ (`custom:CS02`) làm tiêu đề
  if (sectionId.startsWith("custom:")) return ""
  const title = contentSlot(sectionId)?.label_en ?? sectionTitle(sectionId)
  return title === sectionId ? "" : title
}
