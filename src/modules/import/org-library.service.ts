/**
 * FLF-278 trên FLF-335/336 — mẫu và thư viện nội dung cấp tổ chức.
 *
 * Quyền: mọi thành viên xem / dùng; chỉ Lead đăng mẫu (FLF-395); Lead + Analyst sửa / xoá (route `requireRole`; route dự án đi qua chuỗi guard
 * `/projects` + `viewerReadOnly`). Không ghi Spine ở đây: dùng mẫu = một lần import mới (luồng 1 như upload, mapping áp sẵn);
 * nội dung thư viện vào dự án qua bản xem trước (trước baseline) hoặc change request (sau baseline) do FE gửi.
 */
import mongoose from "mongoose"
import { docFileStore } from "../doc-version/doc-file.store.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { CustomBlock, CustomSection } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { isRealText, tableBodyHasRealText } from "../../shared/utils/instruction-text.js"
import { Mode1Error } from "./mode1.errors.js"
import { latestImport, loadImportFile, uploadImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { OrgContentEntry, OrgTemplate, type IOrgContentEntry, type OrgTemplateColumn } from "./org-library.model.js"
import {
  assertCanPublish,
  createDraftVersion,
  deleteFamily,
  findFamily,
  listOrgTemplates,
  publishVersion,
  resolveImportVersion,
  type OrgTemplateSummary,
  type TemplateActor
} from "./org-template-versions.service.js"
import { Project } from "../project/project.model.js"
import { TemplateProfile } from "./template-profile.model.js"
import { normalizeTitle } from "./org-mapping.js"
import { buildSkeleton, scrubProjectName, type PendingDecision } from "./template-skeleton.js"
import type { TemplateIntent } from "./target-structure.js"

export { applyOrgMapping, normalizeTitle } from "./org-mapping.js"

/** Trạng thái import đã qua bước xác nhận mapping (1.5) — mapping lúc này là mapping BA đã chốt. */
const MAPPED_STATUSES: ReadonlySet<string> = new Set(["extracting", "fields_review", "baselining", "incomplete", "drafting", "checking", "gap_review", "delivered", "change_requested"])

// ─── mẫu cấp tổ chức ─────────────────────────────────────────────

export type { OrgTemplateSummary } from "./org-template-versions.service.js"
export { deleteFamily as deleteOrgTemplate, listOrgTemplates } from "./org-template-versions.service.js"

/**
 * FLF-412: lưu dự án thành mẫu tổ chức = **chỉ khung** (luật mẫu khung tự lưu D12 — heading khung, tiêu đề cột, chữ hướng dẫn),
 * không lưu nguyên file của khách. Lead chủ động lưu nên mọi heading cần duyệt đều giữ, tên dự án trong chữ thành chỗ trống.
 * Mục nào khớp heading của dự án thì giữ mapping của dự án (`profile.heading_map`), còn lại theo lần khớp lại của khung.
 */
const cleanSkeletonOf = async (
  projectId: string,
  doc: IImportedDocument,
  profile: { heading_map: { heading_text: string; section_id: string }[]; language?: string | null }
): Promise<{ buffer: Buffer; headings: { heading_text: string; section_id: string }[]; table_map: OrgTemplateColumn[] }> => {
  const project = await Project.findById(projectId, { name: 1 }).lean()
  const opts = { projectName: project?.name ?? "", language: profile.language === "vi" ? ("vi" as const) : ("en" as const) }
  const source = await loadImportFile(doc)
  const first = await buildSkeleton(source, opts)
  const decisions = new Map<string, PendingDecision>(first.review.map((r) => [r.key, { decision: "generic", text: scrubProjectName(r.heading_text, opts) }]))
  const built = decisions.size ? await buildSkeleton(source, opts, decisions) : first
  if (built.empty) throw new Mode1Error("IMPORT_INVALID_STATE", "Tài liệu không có heading nào để lưu thành mẫu", { status: doc.status, to: doc.status, allowed: [] })
  // Cùng tên ở hai nhánh ("Overview" dưới mục 1 và mục 3) ⇒ khớp theo thứ tự xuất hiện, không gom về lần đầu
  const ownSections = new Map<string, string[]>()
  for (const h of profile.heading_map) {
    const key = normalizeTitle(scrubProjectName(h.heading_text, opts))
    ownSections.set(key, [...(ownSections.get(key) ?? []), h.section_id])
  }
  return {
    buffer: built.buffer,
    headings: built.headings.map((h) => ({ heading_text: h.heading_text, section_id: ownSections.get(normalizeTitle(h.heading_text))?.shift() ?? h.section_id })),
    table_map: built.table_map
  }
}

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
    const skeleton = await cleanSkeletonOf(projectId, doc, profile)
    const draft = await createDraftVersion(orgId, actor, family, { buffer: skeleton.buffer, originalname: doc.original_name, size: skeleton.buffer.length }, {
      headings: skeleton.headings,
      table_map: skeleton.table_map,
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

const hasRealContent = (c: CustomSection) => c.blocks.some((b) => b.image_ref || (b.kind === "table" ? tableBodyHasRealText(b.rows) : isRealText(b.text)))

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
