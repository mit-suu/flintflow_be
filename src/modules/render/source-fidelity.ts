/**
 * Dự án "Upload SRS có sẵn": file upload là nền của mọi bản in (Word, PDF, version). Mục chưa đổi so với lúc import ⇒ giữ
 * nguyên văn OOXML gốc (đoạn, bảng, ảnh, chú thích, field); chỉ mục bị change request sửa mới dựng lại từ Spine.
 *
 * - `isSourceBasedProject`: dự án có sẵn có file nền — file không phải khung mẫu, không chuyển từ mode 2, profile có file
 *   nguồn, và (theo mẫu cố định của công ty) hoặc (cấu trúc tự do đủ mục FlintFlow — chế độ 1). Chế độ 4 (thiếu mục, phải chèn /
 *   sắp lại) giữ writer FPT. Chế độ 3 từ SRS đã viết sang Luồng 2 (`mode = fpt`, sau 1.0 là `converted_from = fpt`) vẫn lấy file
 *   của khách làm nền: mục khách viết in nguyên văn, mục FlintFlow soạn dựng từ Spine.
 * - `pristineSectionIds`: mục nguyên vẹn = bản in của mục từ Spine hiện tại **giống hệt** bản in từ Spine mốc (cùng layout,
 *   cùng ngôn ngữ). Mốc = Spine lúc import (bản gốc 0.1); chế độ 3 không có 0.1 ⇒ mốc = Spine lúc vào Luồng 2. So bản in chứ không so dữ liệu ⇒ không cần theo dõi path nào thuộc mục nào.
 */

import { DocVersion } from "../doc-version/doc-version.model.js"
import { IMPORTED_DOC_VERSIONS } from "../doc-version/versioning.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { isTemplateFile, type StructurePreview } from "../import/structure-preview.js"
import { Project } from "../project/project.model.js"
import type { Spine } from "../spine/spine.types.js"
import type { RenderedDocument } from "./rendered-document.types.js"

export interface SourceFidelity {
  /** Mục in nguyên văn từ file nền (không dựng lại). */
  keepSource: ReadonlySet<string>
}

interface ProjectFacts {
  start_kind?: string | null
  converted_from?: string | null
  template_intent?: string | null
  mode?: string | null
}

interface ProfileFacts {
  source_file_ref?: string | null
  target_structure?: { resolved_mode?: number | null } | null
  structure_preview?: StructurePreview | null
  /** Chế độ 3 từ SRS đã viết đã vào Luồng 2 (có Spine mốc). */
  flow2_entry_at?: Date | string | null
}

/** Hàm thuần: dự án có sẵn dùng file upload làm nền bản in. */
export const sourceBasedFrom = (project: ProjectFacts | null, profile: ProfileFacts | null): boolean => {
  if (!project || !profile?.source_file_ref) return false
  // Khung mẫu: chữ trong file là hướng dẫn / ví dụ, không phải nội dung để in lại
  if (isTemplateFile(project, profile)) return false
  if (profile.flow2_entry_at && project.template_intent === "fixed") return true
  if (project.start_kind === "new" || project.converted_from === "fpt" || project.mode !== "import") return false
  if (project.template_intent === "fixed") return true
  return profile.target_structure?.resolved_mode === 1
}

export const isSourceBasedProject = async (projectId: string): Promise<boolean> => {
  const [project, profile] = await Promise.all([
    Project.findById(projectId, { start_kind: 1, converted_from: 1, template_intent: 1, mode: 1 }).lean(),
    TemplateProfile.findOne({ projectId }, { source_file_ref: 1, target_structure: 1, structure_preview: 1, flow2_entry_at: 1 }).lean()
  ])
  return sourceBasedFrom(project as ProjectFacts | null, profile as ProfileFacts | null)
}

/** Spine lúc import (bản gốc 0.1 / 0.0). Chưa có version ⇒ `null` (đang tạo chính bản 0.1: mọi mục nguyên vẹn). */
export const importedSpineOf = async (projectId: string): Promise<Spine | null> => {
  const version = await DocVersion.findOne({ projectId, version: { $in: IMPORTED_DOC_VERSIONS } }).sort({ createdAt: 1 }).lean()
  if (!version) return null
  if (version.spine_snapshot) return version.spine_snapshot as Spine
  if (!version.baseline_ref) return null
  const { loadBaselineSpine } = await import("./assemble.service.js")
  return loadBaselineSpine(projectId, version.baseline_ref)
}

/** Spine lúc vào Luồng 2 (chế độ 3 từ SRS đã viết — không có bản gốc 0.1). Không có ⇒ `null`. */
export const flow2EntrySpineOf = async (projectId: string): Promise<Spine | null> =>
  ((await TemplateProfile.findOne({ projectId }, { flow2_entry_spine: 1 }).lean())?.flow2_entry_spine as Spine | null | undefined) ?? null

const sectionKey = (section: RenderedDocument["sections"][number]): string => JSON.stringify({ heading: section.heading, blocks: section.blocks })

/** Hàm thuần: id mục mà bản in hiện tại trùng bản in lúc import. */
export const pristineSectionIds = (current: RenderedDocument, imported: RenderedDocument): Set<string> => {
  const before = new Map(imported.sections.map((s) => [s.id, sectionKey(s)]))
  return new Set(current.sections.filter((s) => before.get(s.id) === sectionKey(s)).map((s) => s.id))
}

/**
 * Độ trung thành với file nền cho một bản in. `renderImported` dựng Spine lúc import bằng **đúng** cách dựng `current`.
 * Không phải dự án có sẵn / khác ngôn ngữ file ⇒ `undefined` (đường cũ).
 */
export const sourceFidelityFor = async (
  projectId: string,
  current: RenderedDocument,
  renderImported: (spine: Spine) => Promise<RenderedDocument>,
  opts: { otherLanguage?: boolean } = {}
): Promise<SourceFidelity | undefined> => {
  if (opts.otherLanguage || !(await isSourceBasedProject(projectId))) return undefined
  const imported = (await flow2EntrySpineOf(projectId)) ?? (await importedSpineOf(projectId))
  // Đang dựng chính bản 0.1 từ Spine vừa import ⇒ mọi mục nguyên vẹn
  if (!imported) return { keepSource: new Set(current.sections.map((s) => s.id)) }
  return { keepSource: pristineSectionIds(current, await renderImported(imported)) }
}
