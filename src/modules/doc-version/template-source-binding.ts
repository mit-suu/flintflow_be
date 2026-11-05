import { createHash } from "node:crypto"
import { ApiError } from "../../shared/utils/api-error.js"
import { TemplateProfile, type ITemplateProfile } from "../import/template-profile.model.js"
import { Project } from "../project/project.model.js"
import type { TemplateLayout } from "../render/layout-sections.js"
import { docFileStore } from "./doc-file.store.js"
import mongoose from "mongoose"
import { Baseline } from "../spine/baseline.model.js"
import { spineSchema } from "../spine/spine.schema.js"
import { listBaselineRefs } from "../spine/spine.repository.js"
import { DocVersion, type IDocVersion } from "./doc-version.model.js"

export const FIXED_TEMPLATE_RENDERER_REVISION = "fixed-template-v2"

/** Immutable source and mapping captured together when a version is written. */
export type TemplateSourceBinding = Pick<ITemplateProfile,
  "heading_map" | "table_map" | "layout" | "template_family" | "language" |
  "legacy_record_of_changes" | "non_screen_table" | "function_originals" | "section_slices"
> & { source_file_ref: string; source_sha256: string }

export const templateLayoutUnavailable = () => new ApiError(409,
  "Không tìm thấy nguồn mẫu và snapshot phù hợp của phiên bản này.", "TEMPLATE_LAYOUT_UNAVAILABLE")

export const captureTemplateSourceBinding = async (projectId: string): Promise<TemplateSourceBinding | null> => {
  const project = await Project.findById(projectId, { template_intent: 1 }).lean()
  if (project?.template_intent !== "fixed") return null
  const profile = await TemplateProfile.findOne({ projectId }).lean()
  if (!profile?.layout?.length || !profile.heading_map?.length) throw templateLayoutUnavailable()
  if (!profile.source_file_ref) {
    // Current legacy profiles may recover a unique SHA/heading-verified source.
    // Historical versions still require their own saved binding below.
    const { loadFixedTemplateContext } = await import("../render/project-docx-writer.js")
    const { binding } = await loadFixedTemplateContext(projectId)
    return JSON.parse(JSON.stringify(binding)) as TemplateSourceBinding
  }
  let source: Buffer
  try { source = await docFileStore().load(profile.source_file_ref) } catch { throw templateLayoutUnavailable() }
  const sha = createHash("sha256").update(source).digest("hex")
  if (profile.source_sha256 && profile.source_sha256 !== sha) throw templateLayoutUnavailable()
  return JSON.parse(JSON.stringify({
    source_file_ref: profile.source_file_ref, source_sha256: sha,
    heading_map: profile.heading_map, table_map: profile.table_map, layout: profile.layout,
    template_family: profile.template_family, language: profile.language,
    legacy_record_of_changes: profile.legacy_record_of_changes ?? [], non_screen_table: profile.non_screen_table ?? [],
    function_originals: profile.function_originals ?? [], section_slices: profile.section_slices ?? []
  })) as TemplateSourceBinding
}

export const templateLayoutFromBinding = (binding: TemplateSourceBinding): TemplateLayout => ({
  fixedTemplate: true, layout: binding.layout, language: binding.language,
  legacyRecord: binding.legacy_record_of_changes, nonScreenTable: binding.non_screen_table,
  functionOriginals: binding.function_originals, sectionSlices: binding.section_slices
})

/** Resolve only through the selected immutable baseline and its version, never the current profile. */
export const resolveFixedBaselineVersion = async (projectId: string, baselineId?: string): Promise<IDocVersion> => {
  const refs = await listBaselineRefs(projectId)
  const ref = baselineId && !mongoose.isValidObjectId(baselineId)
    ? refs.find((entry) => entry.id === baselineId)?.snapshot_ref
    : baselineId
  if (baselineId && !ref) throw templateLayoutUnavailable()
  const baseline = await Baseline.findOne(
    { projectId, ...(ref ? { _id: ref } : {}) }, null, { lean: true, sort: { at: -1 } }
  )
  if (!baseline || !spineSchema.safeParse(baseline.snapshot).success) throw templateLayoutUnavailable()
  const aliases = [String(baseline._id), ...refs.filter((entry) => entry.snapshot_ref === String(baseline._id)).map((entry) => entry.id)]
  const versions = await DocVersion.find({ projectId, baseline_ref: { $in: aliases } }).lean()
  if (versions.length !== 1 || !versions[0]?.template_source) throw templateLayoutUnavailable()
  return versions[0] as unknown as IDocVersion
}

export const resolveFixedBaselineBinding = async (projectId: string, baselineId?: string): Promise<TemplateSourceBinding> =>
  (await resolveFixedBaselineVersion(projectId, baselineId)).template_source!
