/**
 * FLF-278 trên FLF-335/336 — mẫu cấp tổ chức.
 *
 * Quyền: mọi thành viên xem / dùng; chỉ Lead đăng / xoá mẫu (FLF-395) (route `requireRole`; route dự án đi qua chuỗi guard
 * `/projects` + `viewerReadOnly`). Không ghi Spine ở đây: dùng mẫu = một lần import mới (luồng 1 như upload, mapping áp sẵn).
 */
import { docFileStore } from "../doc-version/doc-file.store.js"
import { uploadImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { OrgTemplate } from "./org-library.model.js"
import { resolveImportVersion } from "./org-template-versions.service.js"
import { Project } from "../project/project.model.js"
import type { TemplateIntent } from "./target-structure.js"

export { applyOrgMapping, normalizeTitle } from "./org-mapping.js"

// ─── mẫu cấp tổ chức ─────────────────────────────────────────────

export type { OrgTemplateSummary } from "./org-template-versions.service.js"
export { deleteFamily as deleteOrgTemplate, listOrgTemplates } from "./org-template-versions.service.js"

/**
 * Dự án dùng mẫu tổ chức: import từ đúng file của bản đã chọn (mặc định bản mới nhất — D16), mapping áp sẵn. Import nhớ
 * (template_id, version) nên đăng bản mới giữa lúc upload và tách file không đổi mapping; dự án gắn bản đó.
 */
export const importFromOrg = async (
  projectId: string,
  orgId: string,
  userId: string,
  /** `intent` (client cũ) bỏ qua — ý định lấy từ Project. */
  body: { org_template_id: string; version?: number; intent?: TemplateIntent }
): Promise<IImportedDocument> => {
  const { family, version } = await resolveImportVersion(orgId, body.org_template_id, body.version)
  const buffer = await docFileStore().load(version.file_ref)
  const doc = await uploadImport(
    projectId,
    userId,
    { buffer, originalname: version.source_file.name, size: buffer.length },
    { org_template_id: String(family._id), org_template_version: version.version }
  )
  await Promise.all([
    OrgTemplate.updateOne({ _id: family._id }, { $inc: { uses: 1 } }),
    Project.updateOne({ _id: projectId, organizationId: orgId }, { $set: { template_ref: { template_id: family._id, version: version.version } } })
  ])
  return doc
}
