/**
 * Dự án "Upload SRS có sẵn": file upload là nền của mọi bản in (Word, PDF, version). Mục chưa đổi so với lúc import ⇒ giữ
 * nguyên văn OOXML gốc (đoạn, bảng, ảnh, chú thích, field); chỉ mục bị change request sửa mới dựng lại từ Spine.
 *
 * - `isSourceBasedProject`: dự án có sẵn có file nền — file không phải khung mẫu, không chuyển từ mode 2, profile có file
 *   nguồn, và (theo mẫu cố định của công ty) hoặc (cấu trúc tự do đủ mục FlintFlow — chế độ 1). Chế độ 4 (thiếu mục, phải chèn /
 *   sắp lại) giữ writer FPT. Chế độ 3 từ SRS đã viết sang Luồng 2 (`mode = fpt`, sau 1.0 là `converted_from = fpt`) vẫn lấy file
 *   của khách làm nền: mục khách viết in nguyên văn, mục FlintFlow soạn dựng từ Spine.
 * - Sau đổi mẫu (`migrated_base_at`): file nền là file mới do FlintFlow dựng từ mẫu đích, mọi chế độ (kể cả chế độ 2 / `converted_from = fpt`
 *   / dự án mới / chế độ 4 — trước đó không có file nền) đều lấy file này làm nền; mốc "nguyên vẹn" = Spine lúc áp dụng đổi mẫu.
 * - `pristineSectionIds`: mục nguyên vẹn = bản in của mục từ Spine hiện tại **giống hệt** bản in từ Spine mốc (cùng layout,
 *   cùng ngôn ngữ). Mốc = Spine lúc đổi mẫu gần nhất; chưa đổi mẫu thì Spine lúc import (bản gốc 0.1); chế độ 3 không có 0.1 ⇒ mốc =
 *   Spine lúc vào Luồng 2. So bản in chứ không so dữ liệu ⇒ không cần theo dõi path nào thuộc mục nào. Dự án đã đổi mẫu neo mục khung theo
 *   `section_id` (không tính chữ heading do mẫu đích đặt); dự án chưa đổi mẫu giữ khoá cũ (heading + khối).
 */

import { DocVersion } from "../doc-version/doc-version.model.js"
import { IMPORTED_DOC_VERSIONS } from "../doc-version/versioning.js"
import { TemplateMigration } from "../template-migration/template-migration.model.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { isTemplateFile, type StructurePreview } from "../import/structure-preview.js"
import { Project } from "../project/project.model.js"
import type { Spine } from "../spine/spine.types.js"
import type { RenderedDocument } from "./rendered-document.types.js"

export interface SourceFidelity {
  /** Mục in nguyên văn từ file nền (không dựng lại). */
  keepSource: ReadonlySet<string>
}

/**
 * Mốc "nguyên vẹn" của một version, chốt cùng lúc với binding mẫu của version đó (`TemplateSourceBinding.fidelity_anchor`):
 * bản in lại của version không đọc profile hiện tại, nên đổi mẫu sau này không làm đổi bản in version cũ.
 */
export interface FidelityAnchor {
  /** Lúc ghi version, dự án có file nền (mục nguyên vẹn in nguyên văn từ file đó). */
  source_based: boolean
  /** Neo mục khung theo `section_id` (file nền do FlintFlow dựng sau đổi mẫu) thay vì heading + khối. */
  by_id: boolean
  /** Spine mốc nhúng sẵn (binding cũ). Binding mới không nhúng Spine (mỗi version một bản sao là quá nặng): dùng `ref`. */
  spine?: Spine | null
  /**
   * Nơi lấy Spine mốc: `migration` = `TemplateMigration.anchor_spine` của lần đổi mẫu (bất biến, không xoá); `flow2` = Spine lúc vào Luồng 2
   * (ghi một lần). Không có cả `spine` lẫn `ref` ⇒ Spine lúc import (suy từ version 0.x, bất biến).
   */
  ref?: { kind: "migration"; id: string } | { kind: "flow2" } | null
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
  /** Đã đổi mẫu: `source_file_ref` là file nền mới do FlintFlow dựng. */
  migrated_base_at?: Date | string | null
}

/** Hàm thuần: dự án có sẵn dùng file upload làm nền bản in. */
export const sourceBasedFrom = (project: ProjectFacts | null, profile: ProfileFacts | null): boolean => {
  if (!project || !profile?.source_file_ref) return false
  // Đã đổi mẫu: file nền mới là nền của bản in, bất kể chế độ ban đầu hay file có từng là khung mẫu
  if (profile.migrated_base_at) return true
  // Khung mẫu: chữ trong file là hướng dẫn / ví dụ, không phải nội dung để in lại
  if (isTemplateFile(project, profile)) return false
  if (profile.flow2_entry_at && project.template_intent === "fixed") return true
  if (project.start_kind === "new" || project.converted_from === "fpt" || project.mode !== "import") return false
  if (project.template_intent === "fixed") return true
  return profile.target_structure?.resolved_mode === 1
}

export const isSourceBasedProject = async (projectId: string, opts: { ignoreMigration?: boolean } = {}): Promise<boolean> => {
  const [project, profile] = await Promise.all([
    Project.findById(projectId, { start_kind: 1, converted_from: 1, template_intent: 1, mode: 1 }).lean(),
    TemplateProfile.findOne({ projectId }, { source_file_ref: 1, target_structure: 1, structure_preview: 1, flow2_entry_at: 1, migrated_base_at: 1 }).lean()
  ])
  const facts = profile as ProfileFacts | null
  return sourceBasedFrom(project as ProjectFacts | null, opts.ignoreMigration && facts ? { ...facts, migrated_base_at: null } : facts)
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

/**
 * Dự án đã đổi mẫu: Spine lúc đổi mẫu gần nhất (mốc "nguyên vẹn" của file nền mới; `null` nếu chưa ghi — bước áp dụng phải ghi
 * cùng lúc với `migrated_base_at`). Chưa đổi mẫu ⇒ `null` (không có đối tượng).
 */
export const migratedBaseOf = async (projectId: string): Promise<{ spine: Spine | null } | null> => {
  const profile = (await TemplateProfile.findOne({ projectId, migrated_base_at: { $ne: null } }, { migrated_base_spine: 1, migrated_base_migration_id: 1 }).lean()) as { migrated_base_spine?: Spine | null; migrated_base_migration_id?: unknown } | null
  if (!profile) return null
  if (profile.migrated_base_spine) return { spine: profile.migrated_base_spine }
  // Mốc nằm ở migration (profile chỉ giữ id)
  const m = profile.migrated_base_migration_id ? ((await TemplateMigration.findById(profile.migrated_base_migration_id, { anchor_spine: 1 }).lean()) as { anchor_spine?: Spine | null } | null) : null
  return { spine: m?.anchor_spine ?? null }
}

/** Spine lúc vào Luồng 2 (chế độ 3 từ SRS đã viết — không có bản gốc 0.1). Không có ⇒ `null`. */
export const flow2EntrySpineOf = async (projectId: string): Promise<Spine | null> =>
  ((await TemplateProfile.findOne({ projectId }, { flow2_entry_spine: 1 }).lean())?.flow2_entry_spine as Spine | null | undefined) ?? null

/** Mục khung của mẫu (heading do mẫu quyết định). `feature:*` / `function:*` / `custom:*` lấy heading từ dữ liệu của người dùng. */
const isTemplateSection = (id: string): boolean => /^(fixed|group|slot):/.test(id)

/**
 * Khoá so mục. Mặc định (dự án chưa đổi mẫu) là heading + khối in như trước. `anchorById` (dự án đã đổi mẫu): mục khung được
 * neo theo `section_id` + khối, chữ heading không tính vì heading do mẫu đích quyết định; mục theo dữ liệu (`feature:*`,
 * `function:*`, `custom:*`) vẫn tính heading — đổi tên là sửa.
 */
const sectionKey = (section: RenderedDocument["sections"][number], anchorById: boolean): string =>
  JSON.stringify(anchorById && isTemplateSection(section.id) ? { blocks: section.blocks } : { heading: section.heading, blocks: section.blocks })

/** Hàm thuần: id mục mà bản in hiện tại trùng bản in lúc import (hoặc lúc đổi mẫu khi `anchorById`). */
export const pristineSectionIds = (current: RenderedDocument, imported: RenderedDocument, opts: { anchorById?: boolean } = {}): Set<string> => {
  const anchor = !!opts.anchorById
  const before = new Map(imported.sections.map((s) => [s.id, sectionKey(s, anchor)]))
  return new Set(current.sections.filter((s) => before.get(s.id) === sectionKey(s, anchor)).map((s) => s.id))
}

/** Mốc của dự án ở thời điểm này — chốt vào binding của version mới. */
export const currentFidelityAnchor = async (projectId: string): Promise<FidelityAnchor> => {
  if (!(await isSourceBasedProject(projectId))) return { source_based: false, by_id: false, ref: null }
  const migrated = await migratedBaseOf(projectId)
  if (migrated) {
    const latest = await TemplateMigration.findOne({ projectId, state: "applied" }, { _id: 1 }).sort({ applied_at: -1 }).lean()
    // Có id migration ⇒ tham chiếu; không có (profile cũ ghi tay) ⇒ nhúng Spine như trước
    return latest ? { source_based: true, by_id: true, ref: { kind: "migration", id: String(latest._id) } } : { source_based: true, by_id: true, spine: migrated.spine }
  }
  return { source_based: true, by_id: false, ref: (await flow2EntrySpineOf(projectId)) ? { kind: "flow2" } : null }
}

/** Spine mốc của một anchor đã chốt trong binding. */
const anchorSpineOf = async (projectId: string, anchor: FidelityAnchor): Promise<Spine | null> => {
  if (anchor.spine) return anchor.spine
  if (anchor.ref?.kind === "migration") {
    const m = (await TemplateMigration.findById(anchor.ref.id, { anchor_spine: 1 }).lean()) as { anchor_spine?: Spine | null } | null
    if (m?.anchor_spine) return m.anchor_spine
  }
  if (anchor.ref?.kind === "flow2") return flow2EntrySpineOf(projectId)
  return importedSpineOf(projectId)
}

/** Đổi mẫu xảy ra sau `createdAt` ⇒ version cũ chưa có mốc phải tính như trước lần đổi mẫu đó. */
const migratedAfter = async (projectId: string, createdAt: Date): Promise<boolean> => {
  const profile = await TemplateProfile.findOne({ projectId, migrated_base_at: { $ne: null } }, { migrated_base_at: 1 }).lean()
  return !!profile?.migrated_base_at && new Date(profile.migrated_base_at).getTime() > createdAt.getTime()
}

export interface SourceFidelityOptions {
  otherLanguage?: boolean
  /** Mốc đã chốt cùng binding của version (bản in lại của version). Có ⇒ không đọc profile hiện tại. */
  anchor?: FidelityAnchor | null
  /** Version đã lưu nhưng chưa có mốc: thời điểm tạo — để bỏ qua các lần đổi mẫu xảy ra sau đó. */
  versionCreatedAt?: Date
}

const fidelityFrom = async (
  current: RenderedDocument,
  renderImported: (spine: Spine) => Promise<RenderedDocument>,
  imported: Spine | null,
  anchorById: boolean
): Promise<SourceFidelity> => {
  // Đang dựng chính bản 0.1 từ Spine vừa import ⇒ mọi mục nguyên vẹn
  if (!imported) return { keepSource: new Set(current.sections.map((s) => s.id)) }
  return { keepSource: pristineSectionIds(current, await renderImported(imported), { anchorById }) }
}

/**
 * Độ trung thành với file nền cho một bản in. `renderImported` dựng Spine lúc import bằng **đúng** cách dựng `current`.
 * Không phải dự án có sẵn / khác ngôn ngữ file ⇒ `undefined` (đường cũ). In lại một version: truyền `anchor` của binding
 * (hoặc `versionCreatedAt` khi version chưa có mốc) để không phụ thuộc lần đổi mẫu về sau.
 */
export const sourceFidelityFor = async (
  projectId: string,
  current: RenderedDocument,
  renderImported: (spine: Spine) => Promise<RenderedDocument>,
  opts: SourceFidelityOptions = {}
): Promise<SourceFidelity | undefined> => {
  if (opts.otherLanguage) return undefined
  if (opts.anchor) {
    if (!opts.anchor.source_based) return undefined
    return fidelityFrom(current, renderImported, await anchorSpineOf(projectId, opts.anchor), opts.anchor.by_id)
  }
  const legacy = !!opts.versionCreatedAt && (await migratedAfter(projectId, opts.versionCreatedAt))
  if (!(await isSourceBasedProject(projectId, { ignoreMigration: legacy }))) return undefined
  const migrated = legacy ? null : await migratedBaseOf(projectId)
  const imported = migrated?.spine ?? (await flow2EntrySpineOf(projectId)) ?? (await importedSpineOf(projectId))
  return fidelityFrom(current, renderImported, imported, !!migrated)
}
