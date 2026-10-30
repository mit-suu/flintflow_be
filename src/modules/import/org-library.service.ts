/**
 * FLF-278 trên FLF-335/336 — mẫu và thư viện nội dung cấp tổ chức.
 *
 * Quyền: mọi thành viên xem / dùng; Lead + Analyst lưu / sửa / xoá (route `requireRole`; route dự án đi qua chuỗi guard
 * `/projects` + `viewerReadOnly`). Không ghi Spine ở đây: dùng mẫu = một lần import mới (luồng 1 như upload, mapping áp sẵn);
 * nội dung thư viện vào dự án qua bản xem trước (trước baseline) hoặc change request (sau baseline) do FE gửi.
 */
import mongoose from "mongoose"
import { docFileStore } from "../doc-version/doc-file.store.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { CustomBlock, CustomSection } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { isRealText } from "../../shared/utils/instruction-text.js"
import { Mode1Error } from "./mode1.errors.js"
import { latestImport, loadImportFile, uploadImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { OrgContentEntry, OrgTemplate, type IOrgContentEntry, type IOrgTemplate } from "./org-library.model.js"
import { TemplateProfile } from "./template-profile.model.js"
import { normalizeTitle } from "./org-mapping.js"
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
  template_family: t.template_family,
  uses: t.uses,
  created_at: t.createdAt.toISOString()
})

export const listOrgTemplates = async (orgId: string): Promise<OrgTemplateSummary[]> =>
  (await OrgTemplate.find({ orgId }).sort({ uses: -1, updatedAt: -1 }).limit(100)).map(summaryOf)

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
  body: { org_template_id: string; intent?: TemplateIntent }
): Promise<IImportedDocument> => {
  const template = mongoose.isValidObjectId(body.org_template_id) ? await OrgTemplate.findOne({ _id: body.org_template_id, orgId }) : null
  if (!template) throw new ApiError(404, "Không tìm thấy mẫu của tổ chức.", "ORG_TEMPLATE_NOT_FOUND")
  const buffer = await docFileStore().load(template.file_ref)
  const doc = await uploadImport(
    projectId,
    userId,
    { buffer, originalname: template.source_file.name, size: buffer.length },
    { ...(body.intent ? { intent: body.intent } : {}), org_template_id: String(template._id) }
  )
  await OrgTemplate.updateOne({ _id: template._id }, { $inc: { uses: 1 } })
  return doc
}

// ─── thư viện nội dung ───────────────────────────────────────────

export interface ContentEntryView {
  id: string
  title: string
  blocks: CustomBlock[]
  updated_at: string
}

const entryView = (e: IOrgContentEntry): ContentEntryView => ({
  id: String(e._id),
  title: e.title,
  blocks: e.blocks.map((b) => ({ kind: b.kind, text: b.text, rows: null, image_ref: null })),
  updated_at: e.updatedAt.toISOString()
})

const duplicate = (err: unknown): never => {
  if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) throw new ApiError(409, "Thư viện đã có mục cùng tiêu đề.", "ORG_CONTENT_DUPLICATE")
  throw err
}

export interface ContentInput {
  title: string
  blocks: { kind: "paragraph" | "list_item"; text: string }[]
}

const toBlocks = (blocks: ContentInput["blocks"]): CustomBlock[] => blocks.map((b) => ({ kind: b.kind, text: b.text.trim(), rows: null, image_ref: null }))

export const listContent = async (orgId: string): Promise<ContentEntryView[]> => (await OrgContentEntry.find({ orgId }).sort({ title: 1 }).limit(500)).map(entryView)

/** Thêm hoặc ghi đè theo tiêu đề (cùng khoá chuẩn hoá ⇒ cùng một mục). */
export const upsertContent = async (orgId: string, userId: string, input: ContentInput): Promise<ContentEntryView> => {
  const key = normalizeTitle(input.title)
  if (!key) throw new ApiError(400, "Tiêu đề không hợp lệ.", "VALIDATION_ERROR")
  const saved = await OrgContentEntry.findOneAndUpdate(
    { orgId, key },
    { $set: { title: input.title.trim(), blocks: toBlocks(input.blocks), updated_by: userId } },
    { upsert: true, returnDocument: "after", runValidators: true }
  ).catch(duplicate)
  return entryView(saved!)
}

export const updateContent = async (orgId: string, userId: string, entryId: string, input: Partial<ContentInput>): Promise<ContentEntryView> => {
  const set = {
    updated_by: userId,
    ...(input.title !== undefined ? { title: input.title.trim(), key: normalizeTitle(input.title) } : {}),
    ...(input.blocks !== undefined ? { blocks: toBlocks(input.blocks) } : {})
  }
  const saved = mongoose.isValidObjectId(entryId)
    ? await OrgContentEntry.findOneAndUpdate({ _id: entryId, orgId }, { $set: set }, { returnDocument: "after", runValidators: true }).catch(duplicate)
    : null
  if (!saved) throw new ApiError(404, "Không tìm thấy mục trong thư viện.", "ORG_CONTENT_NOT_FOUND")
  return entryView(saved)
}

export const deleteContent = async (orgId: string, entryId: string): Promise<void> => {
  if (!mongoose.isValidObjectId(entryId) || !(await OrgContentEntry.deleteOne({ _id: entryId, orgId })).deletedCount) {
    throw new ApiError(404, "Không tìm thấy mục trong thư viện.", "ORG_CONTENT_NOT_FOUND")
  }
}

const customSectionsOf = async (projectId: string): Promise<CustomSection[]> => {
  const spine = await spineRepository.get(projectId)
  if (!spine) throw new ApiError(404, "Không tìm thấy dữ liệu dự án.", "SPINE_NOT_FOUND")
  return spine.custom_sections.filter((c) => c.heading.trim())
}

const hasRealContent = (c: CustomSection) => c.blocks.some((b) => b.image_ref || isRealText(b.text) || (b.rows ?? []).some((r) => r.some(isRealText)))

/** Lưu nội dung đã viết của một mục riêng vào thư viện tổ chức (chỉ đoạn chữ / gạch đầu dòng thật, bỏ chữ hướng dẫn). */
export const saveSectionToLibrary = async (projectId: string, orgId: string, userId: string, customSectionId: string): Promise<ContentEntryView> => {
  const section = (await customSectionsOf(projectId)).find((c) => c.id === customSectionId)
  if (!section) throw new ApiError(404, "Không tìm thấy mục riêng.", "CUSTOM_SECTION_NOT_FOUND")
  const blocks = section.blocks.filter((b) => (b.kind === "paragraph" || b.kind === "list_item") && isRealText(b.text))
  if (!blocks.length) throw new ApiError(422, "Mục chưa có đoạn chữ nào để lưu.", "CUSTOM_SECTION_EMPTY")
  return upsertContent(orgId, userId, { title: section.heading, blocks: blocks.map((b) => ({ kind: b.kind as "paragraph" | "list_item", text: b.text.slice(0, 4000) })) })
}

export interface LibraryMatch {
  custom_section_id: string
  heading: string
  /** Mục chưa có chữ thật (trống hoặc chỉ còn chữ hướng dẫn của mẫu). */
  empty: boolean
  entry: ContentEntryView
}

/** Mục riêng của dự án trùng tiêu đề với mục trong thư viện tổ chức. Không ghi gì. */
export const libraryMatches = async (projectId: string, orgId: string): Promise<LibraryMatch[]> => {
  const [sections, entries] = await Promise.all([customSectionsOf(projectId), OrgContentEntry.find({ orgId }).limit(500)])
  const byKey = new Map(entries.map((e) => [e.key, e]))
  return sections.flatMap((c) => {
    const entry = byKey.get(normalizeTitle(c.heading))
    return entry ? [{ custom_section_id: c.id, heading: c.heading, empty: !hasRealContent(c), entry: entryView(entry) }] : []
  })
}
