/**
 * FLF-278 trên FLF-335/336 — mẫu cấp tổ chức.
 *
 * Quyền: mọi thành viên xem / dùng; Lead + Analyst lưu / sửa / xoá (route `requireRole`; route dự án đi qua chuỗi guard
 * `/projects` + `viewerReadOnly`). Không ghi Spine ở đây: dùng mẫu = một lần import mới (luồng 1 như upload, mapping áp sẵn).
 */
import mongoose from "mongoose"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { vietnameseSearchPattern } from "../../shared/utils/vi-search.js"
import { Mode1Error } from "./mode1.errors.js"
import { latestImport, loadImportFile, uploadImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { OrgTemplate, type IOrgTemplate } from "./org-library.model.js"
import { TemplateProfile } from "./template-profile.model.js"
import { normalizeTemplateFamily } from "./part-bank.js"
import type { TemplateIntent } from "./target-structure.js"

export { applyOrgMapping, normalizeTitle } from "./org-mapping.js"

/** Trạng thái import đã qua bước xác nhận mapping (1.5) — mapping lúc này là mapping BA đã chốt. */
const MAPPED_STATUSES: ReadonlySet<string> = new Set(["extracting", "fields_review", "baselining", "incomplete", "drafting", "checking", "gap_review", "delivered", "change_requested"])

// ─── mẫu cấp tổ chức ─────────────────────────────────────────────

export interface OrgTemplateSummary {
  id: string
  name: string
  source_file_name: string
  heading_count: number
  custom_count: number
  template_family: string | null
  uses: number
  created_at: string
}

const summaryOf = (t: IOrgTemplate): OrgTemplateSummary => ({
  id: String(t._id),
  name: t.name,
  source_file_name: t.source_file.name,
  heading_count: t.headings.length,
  custom_count: t.headings.filter((h) => h.section_id === "unmapped").length,
  template_family: t.template_family ? normalizeTemplateFamily(t.template_family) : null,
  uses: t.uses,
  created_at: t.createdAt.toISOString()
})

export const listOrgTemplates = async (orgId: string): Promise<OrgTemplateSummary[]> =>
  (await OrgTemplate.find({ orgId }).sort({ uses: -1, updatedAt: -1 }).limit(100)).map(summaryOf)

const TEMPLATE_SORTS = {
  uses: { uses: -1, createdAt: -1 },
  recent: { createdAt: -1 },
  name: { name: 1 }
} as const

/** Một trang của thư viện mẫu, kèm tổng số mẫu khớp. Sắp theo tên dùng collation tiếng Việt (Ă sau A, không xếp cuối). */
export const listOrgTemplatesPage = async (
  orgId: string,
  query: { q?: string; sort: keyof typeof TEMPLATE_SORTS; page: number; limit: number }
): Promise<{ items: OrgTemplateSummary[]; meta: { page: number; limit: number; total: number; totalPages: number } }> => {
  const { q, sort, page, limit } = query
  const filter: Record<string, unknown> = { orgId }
  if (q) {
    const pattern = vietnameseSearchPattern(q)
    filter.$or = [{ name: pattern }, { "source_file.name": pattern }]
  }
  const [total, docs] = await Promise.all([
    OrgTemplate.countDocuments(filter),
    OrgTemplate.find(filter)
      .sort({ ...TEMPLATE_SORTS[sort], _id: 1 })
      .collation({ locale: "vi" })
      .skip((page - 1) * limit)
      .limit(limit)
  ])
  return { items: docs.map(summaryOf), meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }
}

export const deleteOrgTemplate = async (orgId: string, templateId: string): Promise<void> => {
  const found = mongoose.isValidObjectId(templateId) ? await OrgTemplate.findOneAndDelete({ _id: templateId, orgId }) : null
  if (!found) throw new ApiError(404, "Không tìm thấy mẫu của tổ chức.", "ORG_TEMPLATE_NOT_FOUND")
  await docFileStore().remove(found.file_ref).catch(() => undefined)
}

/** Lưu file mẫu + mapping đã xác nhận của lần import gần nhất thành mẫu của tổ chức. */
export const saveImportToOrg = async (projectId: string, orgId: string, userId: string, name: string): Promise<OrgTemplateSummary> => {
  const doc = await latestImport(projectId)
  if (!doc || !doc.file_ref || !MAPPED_STATUSES.has(doc.status)) {
    throw new Mode1Error("IMPORT_INVALID_STATE", "Chỉ lưu được mẫu sau khi đã xác nhận mapping heading", { status: doc?.status ?? null, to: doc?.status ?? null, allowed: [] })
  }
  const profile = await TemplateProfile.findOne({ projectId }).lean()
  if (!profile?.heading_map?.length) throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa đọc xong bố cục tài liệu", { status: doc.status, to: doc.status, allowed: [] })
  const buffer = await loadImportFile(doc)
  const fileRef = await docFileStore().save(buffer, { projectId: `org-${orgId}`, kind: "upload", name: doc.original_name })
  const created = await OrgTemplate.create({
    orgId,
    name: name.trim(),
    source_file: { name: doc.original_name, size: doc.size, sha256: doc.sha256 },
    file_ref: fileRef,
    template_family: profile.template_family ?? null,
    headings: profile.heading_map.map((h) => ({ heading_text: h.heading_text, section_id: h.section_id })),
    created_by: userId
  })
  return summaryOf(created)
}

/** Dự án dùng mẫu tổ chức: import từ đúng file đã lưu (không cần upload, không hỏi "bản mới nhất"), mapping áp sẵn. */
export const importFromOrg = async (
  projectId: string,
  orgId: string,
  userId: string,
  /** `intent` (client cũ) bỏ qua — ý định lấy từ Project. */
  body: { org_template_id: string; intent?: TemplateIntent }
): Promise<IImportedDocument> => {
  const template = mongoose.isValidObjectId(body.org_template_id) ? await OrgTemplate.findOne({ _id: body.org_template_id, orgId }) : null
  if (!template) throw new ApiError(404, "Không tìm thấy mẫu của tổ chức.", "ORG_TEMPLATE_NOT_FOUND")
  const buffer = await docFileStore().load(template.file_ref)
  const doc = await uploadImport(
    projectId,
    userId,
    { buffer, originalname: template.source_file.name, size: buffer.length },
    { org_template_id: String(template._id) }
  )
  await OrgTemplate.updateOne({ _id: template._id }, { $inc: { uses: 1 } })
  return doc
}
