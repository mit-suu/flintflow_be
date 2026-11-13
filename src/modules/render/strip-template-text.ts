import { isTemplateFile, type StructurePreview } from "../import/structure-preview.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { Project } from "../project/project.model.js"
import { TemplateMigration } from "../template-migration/template-migration.model.js"

/**
 * Bản in HIỆN TẠI có bỏ chữ hướng dẫn / ví dụ của khung mẫu không. Sau đổi mẫu file nền là tài liệu FlintFlow dựng từ mẫu đích: mục thiếu hiện trống kèm chữ
 * hướng dẫn của mẫu (D7), nên **không** bỏ chữ của mẫu. Chưa đổi mẫu ⇒ như cũ (`isTemplateFile`: file upload là khung mẫu để điền).
 */
export const stripTemplateTextNow = async (projectId: string): Promise<boolean> => {
  const [project, profile] = await Promise.all([
    Project.findById(projectId, { start_kind: 1, template_intent: 1 }).lean(),
    TemplateProfile.findOne({ projectId }, { structure_preview: 1, migrated_base_at: 1 }).lean()
  ])
  if (profile?.migrated_base_at) return false
  return isTemplateFile(project, profile)
}

/**
 * Binding của version đã ghi từ trước khi cờ được chốt vào binding: in lại đúng như lúc version được ghi. Dự án đã đổi mẫu thì lấy `structure_preview` từ
 * snapshot profile của lần đổi mẫu đầu tiên (trạng thái trước mọi lần đổi), không từ profile hiện tại.
 */
export const stripTemplateTextLegacy = async (projectId: string): Promise<boolean> => {
  const [project, profile] = await Promise.all([
    Project.findById(projectId, { start_kind: 1, template_intent: 1 }).lean(),
    TemplateProfile.findOne({ projectId }, { structure_preview: 1, migrated_base_at: 1 }).lean()
  ])
  if (!profile?.migrated_base_at) return isTemplateFile(project, profile)
  const first = (await TemplateMigration.findOne({ projectId, applied_at: { $ne: null } }, { snapshot: 1 }).sort({ applied_at: 1 }).lean()) as { snapshot?: { profile?: { structure_preview?: StructurePreview | null } | null } | null } | null
  return isTemplateFile(project, { structure_preview: first?.snapshot?.profile?.structure_preview ?? null })
}
