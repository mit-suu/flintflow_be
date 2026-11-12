/**
 * FLF-278 trên FLF-335/336 — mẫu cấp tổ chức.
 *
 * Quyền: mọi thành viên xem / dùng; chỉ Lead đăng / xoá mẫu (FLF-395) (route `requireRole`; route dự án đi qua chuỗi guard
 * `/projects` + `viewerReadOnly`). Không ghi Spine ở đây: dùng mẫu = một lần import mới (luồng 1 như upload, mapping áp sẵn).
 */
import mongoose from "mongoose"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { Mode1Error } from "./mode1.errors.js"
import { latestImport, loadImportFile, uploadImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { OrgTemplate } from "./org-library.model.js"
import {
  assertCanPublish,
  createDraftVersion,
  deleteFamily,
  findFamily,
  listOrgTemplates,
  publishVersion,
  resolveImportVersion,
  toColumns,
  type OrgTemplateSummary,
  type TemplateActor
} from "./org-template-versions.service.js"
import { Project } from "../project/project.model.js"
import { TemplateProfile } from "./template-profile.model.js"
import type { TemplateIntent } from "./target-structure.js"

export { applyOrgMapping, normalizeTitle } from "./org-mapping.js"

/** Trạng thái import đã qua bước xác nhận mapping (1.5) — mapping lúc này là mapping BA đã chốt. */
const MAPPED_STATUSES: ReadonlySet<string> = new Set(["extracting", "fields_review", "baselining", "incomplete", "drafting", "checking", "gap_review", "delivered", "change_requested"])

// ─── mẫu cấp tổ chức ─────────────────────────────────────────────

export type { OrgTemplateSummary } from "./org-template-versions.service.js"
export { deleteFamily as deleteOrgTemplate, listOrgTemplates } from "./org-template-versions.service.js"

/**
 * Lưu file + mapping đã xác nhận của lần import gần nhất thành mẫu của tổ chức (họ mới, hoặc bản mới của `template_id`).
 * Chỉ Lead (FLF-395): đi qua `publishVersion` như mọi bản `org`; mapping đã chốt ở dự án nên đăng ngay. Dự án gắn bản này.
 */
export const saveImportToOrg = async (
  projectId: string,
  orgId: string,
  actor: TemplateActor,
  body: { name: string; template_id?: string }
): Promise<OrgTemplateSummary> => {
  assertCanPublish(actor)
  const doc = await latestImport(projectId)
  if (!doc || !doc.file_ref || !MAPPED_STATUSES.has(doc.status)) {
    throw new Mode1Error("IMPORT_INVALID_STATE", "Chỉ lưu được mẫu sau khi đã xác nhận mapping heading", { status: doc?.status ?? null, to: doc?.status ?? null, allowed: [] })
  }
  const profile = await TemplateProfile.findOne({ projectId }).lean()
  if (!profile?.heading_map?.length) throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa đọc xong bố cục tài liệu", { status: doc.status, to: doc.status, allowed: [] })
  const existing = body.template_id ? await findFamily(orgId, body.template_id) : null
  const family = existing ?? (await OrgTemplate.create({ orgId, name: body.name.trim(), created_by: actor.userId, latest_version: 0 }))
  try {
    const buffer = await loadImportFile(doc)
    const draft = await createDraftVersion(orgId, actor, family, { buffer, originalname: doc.original_name, size: doc.size }, {
      headings: profile.heading_map.map((h) => ({ heading_text: h.heading_text, section_id: h.section_id })),
      table_map: toColumns(profile.table_map ?? []),
      language: profile.language ?? "en",
      template_family: profile.template_family ?? null
    })
    await publishVersion(orgId, actor, String(family._id), draft.version)
    await Project.updateOne({ _id: projectId, organizationId: orgId }, { $set: { template_ref: { template_id: family._id, version: draft.version } } })
  } catch (err) {
    // Họ vừa tạo cho lần lưu này ⇒ dọn cả bản + file đã ghi, không để bản mồ côi
    if (!existing) await deleteFamily(orgId, String(family._id)).catch(() => undefined)
    throw err
  }
  const summary = (await listOrgTemplates(orgId, "lead")).find((t) => t.id === String(family._id))
  if (!summary) throw new ApiError(404, "Không tìm thấy mẫu của tổ chức.", "ORG_TEMPLATE_NOT_FOUND")
  return summary
}

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
