/**
 * FLF-395 — version của mẫu tổ chức (D1, D2, D3, D16).
 *
 * `OrgTemplate` là họ mẫu; mỗi bản là một `OrgTemplateVersion` (file + mapping heading + mapping cột + ngôn ngữ). Bản `org`
 * chỉ ra đời qua `publishVersion` (chỉ Lead / hệ thống); đăng xong báo Lead + Analyst có dự án theo bản cũ. Mọi truy vấn kèm
 * `orgId` của người gọi — không tin id từ client.
 */
import { createHash } from "node:crypto"
import mongoose from "mongoose"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { Membership, type OrgRole } from "../organization/membership.model.js"
import { notify } from "../notification/notification.service.js"
import { Project } from "../project/project.model.js"
import { TemplateMigration } from "../template-migration/template-migration.model.js"
import { User } from "../user/user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { Mode1Error } from "./mode1.errors.js"
import { OrgTemplate, OrgTemplateVersion, type IOrgTemplate, type IOrgTemplateVersion, type OrgTemplateColumn, type OrgTemplateHeading } from "./org-library.model.js"
import { parseDocument } from "./parse.service.js"
import { normalizeTemplateFamily } from "./part-bank.js"
import { preflightDocx } from "./preflight.service.js"
import { autoConfirmMapping, matchProfile } from "./profile-match.service.js"
import { isKnownSectionId } from "./section-catalog.js"
import type { TableMapEntry } from "./template-profile.model.js"

/** Người thao tác: thành viên org theo vai trò, hoặc hệ thống (tự lưu khung sau baseline). */
export interface TemplateActor {
  userId: string
  role: OrgRole | "system"
}

export interface TemplateFile {
  buffer: Buffer
  originalname: string
  size: number
}

/** Bản đã phân tích, chưa lưu. */
export interface AnalyzedTemplate {
  headings: OrgTemplateHeading[]
  table_map: OrgTemplateColumn[]
  language: string
  template_family: string | null
}

const NOT_FOUND = () => new ApiError(404, "Không tìm thấy mẫu của tổ chức.", "ORG_TEMPLATE_NOT_FOUND")
const MIGRATION_IN_USE = () => new ApiError(409, "Có dự án đang đổi sang mẫu này (chưa áp dụng hoặc huỷ), chưa xoá được.", "ORG_TEMPLATE_IN_USE_BY_MIGRATION")
const VERSION_NOT_FOUND = () => new ApiError(404, "Không tìm thấy bản này của mẫu.", "ORG_TEMPLATE_VERSION_NOT_FOUND")

/** Chỉ Lead (hoặc hệ thống) đăng được bản mẫu dùng chung cho org. */
export const assertCanPublish = (actor: TemplateActor): void => {
  if (actor.role !== "lead" && actor.role !== "system") throw new ApiError(403, "Chỉ Lead được đăng bản mới của mẫu tổ chức.", "ORG_ROLE_FORBIDDEN")
}

export const toColumns = (table: readonly TableMapEntry[]): OrgTemplateColumn[] =>
  table.map((t) => ({ block_id: t.block_id, column_index: t.column_index, header: t.header, field_path: t.field_path }))

/** Đọc file mẫu: preflight (từ chối ⇒ 422 như import) → tách khối → khớp mẫu bắt buộc → tự nhận mục độ tin thấp. Không AI. */
export const analyzeTemplateFile = async (buffer: Buffer): Promise<AnalyzedTemplate> => {
  const pre = await preflightDocx(buffer)
  if (pre.status === "rejected") throw new Mode1Error("IMPORT_FILE_REJECTED", "File mẫu chưa nhập được, xem danh sách lỗi", { issues: pre.issues })
  const { blocks } = await parseDocument(buffer)
  const matched = matchProfile(blocks, { fixedTemplate: true })
  autoConfirmMapping(matched)
  return {
    headings: matched.heading_map.map((h) => ({
      heading_text: h.heading_text,
      section_id: h.section_id,
      ...(h.auto_confirmed ? { auto_confirmed: true } : {}),
      ...(h.guidance ? { guidance: h.guidance } : {})
    })),
    table_map: toColumns(matched.table_map),
    language: matched.language,
    template_family: matched.template_family ?? null
  }
}

const isDuplicateKey = (err: unknown) => err instanceof mongoose.mongo.MongoServerError && err.code === 11000

/**
 * Cấp số bản kế tiếp bằng một lệnh nguyên tử trên họ mẫu (`version_seq` chỉ tăng): hai người tạo cùng lúc nhận hai số khác
 * nhau; xoá bản không làm số đó bị cấp lại (dự án đang gắn số cũ không bị trỏ sang file khác).
 */
const nextVersionNumber = async (templateId: mongoose.Types.ObjectId): Promise<number> => {
  const family = await OrgTemplate.findOneAndUpdate(
    { _id: templateId },
    [{ $set: { version_seq: { $add: [{ $max: [{ $ifNull: ["$version_seq", 0] }, { $ifNull: ["$latest_version", 0] }] }, 1] } } }],
    { returnDocument: "after", updatePipeline: true }
  )
    .select("version_seq")
    .lean()
  if (!family) throw NOT_FOUND()
  return family.version_seq
}

const createNextVersion = async (fields: Omit<Partial<IOrgTemplateVersion>, "version">): Promise<IOrgTemplateVersion> =>
  OrgTemplateVersion.create({ ...fields, version: await nextVersionNumber(fields.template_id!) })

/** Họ mẫu cũ chưa từng có bản thật (file + mapping nằm trên họ). */
const isLegacy = (t: IOrgTemplate): boolean => !t.version_seq && !!t.file_ref && !!t.source_file && !!t.headings

/** Mẫu cũ đã dùng được trước đây ⇒ đọc lại lỗi (preflight siết hơn…) không được làm mất mẫu: thiếu mapping cột / ngôn ngữ thì để mặc định. */
const analyzeLegacyFile = async (t: IOrgTemplate): Promise<Pick<AnalyzedTemplate, "table_map" | "language" | "template_family">> => {
  try {
    return await analyzeTemplateFile(await docFileStore().load(t.file_ref!))
  } catch (error) {
    console.error(`[OrgTemplate] đọc lại file mẫu cũ ${String(t._id)} lỗi — bản 1 không có mapping cột:`, error instanceof Error ? error.message : error)
    return { table_map: [], language: "en", template_family: null }
  }
}

/**
 * Bản ghi họ mẫu cũ (trước FLF-395, file + mapping nằm thẳng trên họ) ⇒ tạo bản 1 đã đăng từ đúng file đó; đọc lại file để có
 * `table_map` + `language`, mapping giữ nguyên như BA đã xác nhận. Đã có bản ⇒ không làm gì. Dùng chung cho script migrate
 * và lần đầu dự án dùng mẫu cũ. Field cũ trên họ giữ nguyên (`version_seq ≥ 1` đánh dấu đã tách).
 */
export const materializeLegacyVersion = async (t: IOrgTemplate): Promise<IOrgTemplateVersion | null> => {
  if (!isLegacy(t)) return null
  const existing = await OrgTemplateVersion.findOne({ template_id: t._id, version: 1 })
  if (existing) return existing
  const analyzed = await analyzeLegacyFile(t)
  let created: IOrgTemplateVersion
  try {
    // Bản 1 là mẫu đã có từ trước ⇒ giữ ngày tạo của họ cũ (thư viện hiện ngày theo `createdAt`), không lấy lúc tách
    const [doc] = await OrgTemplateVersion.create([{
      template_id: t._id,
      orgId: t.orgId,
      version: 1,
      status: "published",
      visibility: "org",
      project_id: null,
      source_file: t.source_file,
      file_ref: t.file_ref,
      template_family: t.template_family ?? analyzed.template_family,
      language: analyzed.language,
      headings: t.headings,
      table_map: analyzed.table_map,
      created_by: t.created_by,
      published_at: t.createdAt,
      createdAt: t.createdAt,
      updatedAt: t.createdAt
    }], { timestamps: false })
    created = doc
  } catch (err) {
    // Hai lượt cùng migrate một họ ⇒ lượt sau đọc bản đã tạo
    if (!isDuplicateKey(err)) throw err
    return OrgTemplateVersion.findOne({ template_id: t._id, version: 1 })
  }
  await OrgTemplate.updateOne({ _id: t._id }, { $max: { latest_version: 1, version_seq: 1 } })
  return created
}

/** Họ mẫu của thư viện tổ chức (không gồm họ ẩn của dự án — xem `findFamilyAny`). */
export const findFamily = async (orgId: string, templateId: string): Promise<IOrgTemplate> => {
  const t = mongoose.isValidObjectId(templateId) ? await OrgTemplate.findOne({ _id: templateId, orgId, project_id: null }) : null
  if (!t) throw NOT_FOUND()
  return t
}

/** Mọi họ mẫu của org kể cả họ ẩn của dự án — chỉ cho luồng đổi mẫu, nơi người gọi tự kiểm họ ẩn có thuộc dự án mình không. */
export const findFamilyAny = async (orgId: string, templateId: string): Promise<IOrgTemplate> => {
  const t = mongoose.isValidObjectId(templateId) ? await OrgTemplate.findOne({ _id: templateId, orgId }) : null
  if (!t) throw NOT_FOUND()
  return t
}

export const findVersion = async (orgId: string, templateId: string, version: number): Promise<IOrgTemplateVersion> => {
  const v = Number.isInteger(version) && version > 0 && mongoose.isValidObjectId(templateId) ? await OrgTemplateVersion.findOne({ template_id: templateId, orgId, version }) : null
  if (!v) throw VERSION_NOT_FOUND()
  return v
}

/** Lưu file vào kho riêng của org rồi tạo bản nháp kế tiếp. */
export const createDraftVersion = async (
  orgId: string,
  actor: TemplateActor,
  family: IOrgTemplate,
  file: TemplateFile,
  analyzed: AnalyzedTemplate
): Promise<IOrgTemplateVersion> => {
  await materializeLegacyVersion(family)
  const fileRef = await docFileStore().save(file.buffer, { projectId: `org-${orgId}`, kind: "upload", name: file.originalname })
  try {
    return await createNextVersion({
      template_id: family._id as mongoose.Types.ObjectId,
      orgId: new mongoose.Types.ObjectId(orgId),
      status: "draft",
      visibility: "org",
      project_id: null,
      source_file: { name: file.originalname, size: file.size, sha256: createHash("sha256").update(file.buffer).digest("hex") },
      file_ref: fileRef,
      template_family: analyzed.template_family,
      language: analyzed.language,
      headings: analyzed.headings,
      table_map: analyzed.table_map,
      created_by: new mongoose.Types.ObjectId(actor.userId),
      published_at: null
    })
  } catch (err) {
    await docFileStore().remove(fileRef).catch(() => undefined)
    throw err
  }
}

/**
 * Bản riêng của một dự án (Analyst tải file khi đổi mẫu): không hiện ở thư viện, không thông báo, không tính vào `latest_version`.
 * Họ mẫu ẩn dùng lại cho các lần tải sau của cùng dự án.
 */
export const createProjectVersion = async (
  orgId: string,
  projectId: string,
  projectName: string,
  actor: TemplateActor,
  file: TemplateFile,
  analyzed: AnalyzedTemplate
): Promise<{ family: IOrgTemplate; version: IOrgTemplateVersion }> => {
  const existing = await OrgTemplate.findOne({ orgId, project_id: projectId })
  const family =
    existing ??
    (await OrgTemplate.create({ orgId, name: `${projectName.trim().slice(0, 100)} — mẫu tải lên`, created_by: actor.userId, latest_version: 0, project_id: projectId }))
  const fileRef = await docFileStore().save(file.buffer, { projectId: `org-${orgId}`, kind: "upload", name: file.originalname })
  try {
    const version = await createNextVersion({
      template_id: family._id as mongoose.Types.ObjectId,
      orgId: new mongoose.Types.ObjectId(orgId),
      status: "published",
      visibility: "project",
      project_id: new mongoose.Types.ObjectId(projectId),
      source_file: { name: file.originalname, size: file.size, sha256: createHash("sha256").update(file.buffer).digest("hex") },
      file_ref: fileRef,
      template_family: analyzed.template_family,
      language: analyzed.language,
      headings: analyzed.headings,
      table_map: analyzed.table_map,
      created_by: new mongoose.Types.ObjectId(actor.userId),
      published_at: new Date()
    })
    return { family, version }
  } catch (err) {
    await docFileStore().remove(fileRef).catch(() => undefined)
    if (!existing) await OrgTemplate.deleteOne({ _id: family._id })
    throw err
  }
}

/** Huỷ bản riêng của dự án vừa tạo mà lần đổi mẫu không lập được (không để bản mồ côi). */
export const discardProjectVersion = async (version: IOrgTemplateVersion): Promise<void> => {
  await OrgTemplateVersion.deleteOne({ _id: version._id })
  await docFileStore().remove(version.file_ref).catch(() => undefined)
  if (!(await OrgTemplateVersion.exists({ template_id: version.template_id }))) await OrgTemplate.deleteOne({ _id: version.template_id })
}

/** Tải file mẫu lên thư viện: họ mới (`templateId` trống, cần `name`) hoặc bản mới của họ có sẵn. Ra bản nháp chờ Lead rà mapping. */
export const uploadTemplateDraft = async (
  orgId: string,
  actor: TemplateActor,
  input: { templateId?: string; name?: string; file: TemplateFile }
): Promise<TemplateVersionDetail> => {
  assertCanPublish(actor)
  const family = input.templateId ? await findFamily(orgId, input.templateId) : null
  if (!family && !input.name?.trim()) throw new ApiError(400, "Cần đặt tên cho mẫu mới.", "VALIDATION_ERROR", { field: "name" })
  // Đọc file trước khi tạo họ — file hỏng không để lại họ rỗng
  const analyzed = await analyzeTemplateFile(input.file.buffer)
  const target = family ?? (await OrgTemplate.create({ orgId, name: input.name!.trim(), created_by: actor.userId, latest_version: 0 }))
  try {
    const draft = await createDraftVersion(orgId, actor, target, input.file, analyzed)
    return detailOf(target, draft, 0, await publisherNames(orgId, [draft.created_by]))
  } catch (err) {
    if (!family) await OrgTemplate.deleteOne({ _id: target._id })
    throw err
  }
}

export interface HeadingEdit {
  index: number
  section_id: string
}

/**
 * Đường duy nhất ra bản `org` dùng được: Lead rà mapping tự nhận của bản nháp (sửa `section_id` theo vị trí heading) rồi
 * đăng. Họ mẫu trỏ bản mới nhất; Lead + Analyst có dự án theo bản cũ hơn nhận thông báo.
 */
export const publishVersion = async (
  orgId: string,
  actor: TemplateActor,
  templateId: string,
  version: number,
  edits: readonly HeadingEdit[] = [],
  /** Dự án vừa tự gắn bản này (tự lưu khung) ⇒ không báo chính nó. */
  opts: { skipProjectIds?: readonly string[] } = {}
): Promise<TemplateVersionDetail> => {
  assertCanPublish(actor)
  const family = await findFamily(orgId, templateId)
  const draft = await findVersion(orgId, templateId, version)
  if (draft.status !== "draft" || draft.visibility !== "org") throw new ApiError(409, "Bản này đã đăng hoặc không thuộc thư viện tổ chức.", "ORG_TEMPLATE_VERSION_PUBLISHED")
  const headings = draft.headings.map((h) => ({ heading_text: h.heading_text, section_id: h.section_id, ...(h.auto_confirmed ? { auto_confirmed: true } : {}), ...(h.guidance ? { guidance: h.guidance } : {}) }))
  for (const e of edits) {
    if (!headings[e.index]) throw new ApiError(400, `Không có tiêu đề thứ ${e.index + 1} trong file mẫu.`, "VALIDATION_ERROR", { field: "headings" })
    if (!isKnownSectionId(e.section_id)) throw new ApiError(400, "Mục được chọn không có trong mẫu.", "VALIDATION_ERROR", { field: "headings" })
    headings[e.index] = { heading_text: headings[e.index].heading_text, section_id: e.section_id, ...(headings[e.index].guidance ? { guidance: headings[e.index].guidance } : {}) }
  }
  const published = await OrgTemplateVersion.findOneAndUpdate(
    { _id: draft._id, status: "draft" },
    { $set: { status: "published", headings, published_at: new Date() } },
    { returnDocument: "after", runValidators: true }
  )
  if (!published) throw new ApiError(409, "Bản này vừa được đăng.", "ORG_TEMPLATE_VERSION_PUBLISHED")
  const updated = await OrgTemplate.findOneAndUpdate({ _id: family._id }, { $max: { latest_version: published.version } }, { returnDocument: "after" })
  // Đăng một bản nháp cũ hơn bản mới nhất ⇒ không có gì mới để báo
  if (updated && updated.latest_version === published.version) await notifyNewVersion(orgId, updated, published.version, actor.userId, opts.skipProjectIds ?? [])
  return detailOf(updated ?? family, published, 0, await publisherNames(orgId, [published.created_by]))
}

/** D3: báo Lead + Analyst (không Viewer, không người vừa đăng) khi org còn dự án theo bản cũ hơn. Lỗi không chặn việc đăng. */
const notifyNewVersion = async (orgId: string, family: IOrgTemplate, version: number, actorUserId: string, skipProjectIds: readonly string[]): Promise<void> => {
  // Khung tự lưu (D12) chỉ thuộc dự án nguồn: dự án khác chỉ dùng chung vì khung trùng, không bị kéo theo cấu trúc mới (chốt 10/11)
  if (family.skeleton_of) return
  try {
    // Dự án đã lưu trữ không còn làm việc ⇒ không báo
    const projects = await Project.find({ organizationId: orgId, status: { $ne: "archived" }, _id: { $nin: skipProjectIds }, "template_ref.template_id": family._id, "template_ref.version": { $lt: version } })
      .select("_id name")
      .lean()
    if (!projects.length) return
    const members = await Membership.find({ organizationId: orgId, role: { $in: ["lead", "analyst"] }, userId: { $ne: actorUserId } }).select("userId").lean()
    const n = projects.length
    await Promise.all(
      members.map((m) =>
        notify(String(m.userId), {
          type: "template_version_published",
          title: `Mẫu "${family.name}" có bản ${version}`,
          body: n === 1 ? `Dự án "${projects[0].name}" đang theo bản cũ. Mở dự án để cập nhật sang mẫu mới hoặc để sau.` : `${n} dự án đang theo bản cũ. Mở từng dự án để cập nhật sang mẫu mới hoặc để sau.`,
          link: n === 1 ? `/projects/${String(projects[0]._id)}` : "/home",
          organizationId: orgId,
          meta: { template_id: String(family._id), version, project_ids: projects.map((p) => String(p._id)) }
        })
      )
    )
  } catch (error) {
    console.error(`[OrgTemplate] notify new version failed (${String(family._id)} v${version}):`, error)
  }
}

// ─── đọc ─────────────────────────────────────────────────────────

export interface TemplateVersionSummary {
  version: number
  status: "draft" | "published"
  source_file_name: string
  heading_count: number
  custom_count: number
  language: string
  template_family: string | null
  project_count: number
  /** FLF-395 (D13): mục BA tự đặt của mẫu khung còn chờ duyệt. */
  pending_count: number
  /** Người tạo / đăng bản này (tên hiển thị nếu còn là thành viên của org, không thì chỉ id); `null` khi bản ghi cũ không còn người tạo. */
  published_by: { id: string; name: string | null } | null
  created_at: string
}

export interface TemplateVersionDetail extends TemplateVersionSummary {
  template_id: string
  name: string
  headings: (OrgTemplateHeading & { index: number })[]
}

const familyLabel = (f: string | null | undefined) => (f ? normalizeTemplateFamily(f) : null)

/** Tên hiển thị của người tạo bản, chỉ cho người vẫn là thành viên của chính org (không lộ tên người ngoài org). */
const publisherNames = async (orgId: string, userIds: readonly unknown[]): Promise<Map<string, string>> => {
  const ids = [...new Set(userIds.filter(Boolean).map(String))]
  if (!ids.length) return new Map()
  const members = await Membership.find({ organizationId: orgId, userId: { $in: ids } }).select("userId").lean()
  const memberIds = members.map((m) => String(m.userId))
  if (!memberIds.length) return new Map()
  const users = await User.find({ _id: { $in: memberIds } }).select("name").lean()
  return new Map(users.map((u) => [String(u._id), u.name?.trim() ?? ""]).filter(([, name]) => !!name) as [string, string][])
}

const versionSummary = (
  v: Pick<IOrgTemplateVersion, "version" | "status" | "source_file" | "headings" | "language" | "template_family" | "createdAt"> & { pending_headings?: { decision: string }[]; created_by?: unknown },
  projectCount: number,
  names: ReadonlyMap<string, string> = new Map()
): TemplateVersionSummary => ({
  version: v.version,
  status: v.status,
  source_file_name: v.source_file.name,
  heading_count: v.headings.length,
  custom_count: v.headings.filter((h) => h.section_id === "unmapped").length,
  language: v.language,
  template_family: familyLabel(v.template_family),
  project_count: projectCount,
  pending_count: (v.pending_headings ?? []).filter((p) => p.decision === "pending").length,
  published_by: v.created_by ? { id: String(v.created_by), name: names.get(String(v.created_by)) ?? null } : null,
  created_at: v.createdAt.toISOString()
})

const detailOf = (family: IOrgTemplate, v: IOrgTemplateVersion, projectCount = 0, names: ReadonlyMap<string, string> = new Map()): TemplateVersionDetail => ({
  ...versionSummary(v, projectCount, names),
  template_id: String(family._id),
  name: family.name,
  headings: v.headings.map((h, index) => ({ index, heading_text: h.heading_text, section_id: h.section_id, ...(h.auto_confirmed ? { auto_confirmed: true } : {}), ...(h.guidance ? { guidance: h.guidance } : {}) }))
})

/** Bản ghi cũ chưa migrate đọc như bản 1 đã đăng (không ghi gì). */
const legacyView = (t: IOrgTemplate) => ({
  version: 1,
  status: "published" as const,
  source_file: t.source_file!,
  headings: t.headings!,
  language: "en",
  template_family: t.template_family ?? null,
  created_by: t.created_by,
  createdAt: t.createdAt
})

export interface OrgTemplateSummary {
  id: string
  name: string
  /** Các field dưới theo bản mới nhất (giữ shape cũ cho ô chọn mẫu). */
  source_file_name: string
  heading_count: number
  custom_count: number
  template_family: string | null
  uses: number
  created_at: string
  latest_version: number
  project_count: number
  /** Mục chờ duyệt của bản mới nhất (mẫu khung tự lưu). */
  pending_count: number
  /** Mẫu khung tự lưu từ một dự án (D12). */
  skeleton: boolean
  /** Dự án nguồn của mẫu khung tự lưu (mở màn duyệt heading chờ từ thư viện); mẫu thường ⇒ `null`. */
  skeleton_source_project_id: string | null
  /** Mới nhất trước. Bản nháp chỉ trả cho Lead. */
  versions: TemplateVersionSummary[]
}

/** Thư viện mẫu của org: mỗi họ kèm các bản + số dự án theo từng bản — 3 truy vấn cho cả trang, không N+1. */
export const listOrgTemplates = async (orgId: string, role: OrgRole): Promise<OrgTemplateSummary[]> => {
  const families = await OrgTemplate.find({ orgId, project_id: null }).sort({ uses: -1, updatedAt: -1 }).limit(100)
  if (!families.length) return []
  const ids = families.map((f) => f._id)
  const [versions, counts] = await Promise.all([
    OrgTemplateVersion.find({ orgId, template_id: { $in: ids }, visibility: "org", ...(role === "lead" ? {} : { status: "published" }) })
      .select("template_id version status source_file headings language template_family pending_headings created_by createdAt")
      .sort({ version: -1 })
      .lean(),
    Project.aggregate<{ _id: { t: mongoose.Types.ObjectId; v: number }; n: number }>([
      { $match: { organizationId: new mongoose.Types.ObjectId(orgId), "template_ref.template_id": { $in: ids } } },
      { $group: { _id: { t: "$template_ref.template_id", v: "$template_ref.version" }, n: { $sum: 1 } } }
    ])
  ])
  const names = await publisherNames(orgId, [...versions.map((v) => v.created_by), ...families.filter(isLegacy).map((f) => f.created_by)])
  const countOf = (t: unknown, v: number) => counts.find((c) => String(c._id.t) === String(t) && c._id.v === v)?.n ?? 0
  return families.flatMap((f) => {
    const own = versions.filter((v) => String(v.template_id) === String(f._id))
    const rows = own.length ? own : isLegacy(f) ? [legacyView(f)] : []
    const summaries = rows.map((v) => versionSummary(v as IOrgTemplateVersion, countOf(f._id, v.version), names))
    const latest = rows.find((v) => v.status === "published")
    // Họ chỉ có bản nháp: chỉ Lead thấy (để đăng tiếp hoặc xoá)
    if (!latest && role !== "lead") return []
    const head = latest ?? rows[0]
    if (!head) return []
    return [
      {
        id: String(f._id),
        name: f.name,
        source_file_name: head.source_file.name,
        heading_count: head.headings.length,
        custom_count: head.headings.filter((h) => h.section_id === "unmapped").length,
        template_family: familyLabel(head.template_family),
        uses: f.uses,
        created_at: f.createdAt.toISOString(),
        latest_version: latest ? Math.max(f.latest_version, latest.version) : 0,
        project_count: summaries.reduce((n, s) => n + s.project_count, 0),
        pending_count: summaries[0]?.pending_count ?? 0,
        skeleton: !!f.skeleton_of,
        skeleton_source_project_id: f.skeleton_of ? String(f.skeleton_of) : null,
        versions: summaries
      }
    ]
  })
}

/** Chi tiết một bản (mapping theo heading) — để Lead rà trước khi đăng, mọi thành viên xem được bản đã đăng. */
export const getVersionDetail = async (orgId: string, role: OrgRole, templateId: string, version: number): Promise<TemplateVersionDetail> => {
  const family = await findFamily(orgId, templateId)
  const v = await findVersion(orgId, templateId, version)
  if (v.visibility !== "org" || (v.status === "draft" && role !== "lead")) throw VERSION_NOT_FOUND()
  const projectCount = await Project.countDocuments({ organizationId: orgId, "template_ref.template_id": family._id, "template_ref.version": version })
  return detailOf(family, v, projectCount, await publisherNames(orgId, [v.created_by]))
}

/**
 * Bản mà một lần import sẽ dùng: `version` cho trước hoặc bản đã đăng mới nhất. Họ cũ chưa migrate ⇒ tạo bản 1 trước. Chỉ
 * nhận bản `org` đã đăng (bản nháp / bản riêng của dự án khác ⇒ 404).
 */
export const resolveImportVersion = async (orgId: string, templateId: string, version?: number): Promise<{ family: IOrgTemplate; version: IOrgTemplateVersion }> => {
  const family = await findFamily(orgId, templateId)
  await materializeLegacyVersion(family)
  const v = version
    ? await findVersion(orgId, templateId, version)
    : await OrgTemplateVersion.findOne({ template_id: family._id, orgId, visibility: "org", status: "published" }).sort({ version: -1 })
  if (!v || v.status !== "published" || v.visibility !== "org") throw VERSION_NOT_FOUND()
  return { family, version: v }
}

// ─── xoá ─────────────────────────────────────────────────────────

/**
 * Xoá một bản (D2: chỉ khi người dùng xoá). Dự án đang theo bản đó giữ nguyên file nền của chính nó; trả số dự án để FE báo.
 * Hết bản ⇒ xoá luôn họ mẫu.
 */
export const deleteVersion = async (orgId: string, templateId: string, version: number): Promise<{ deleted: true; project_count: number; template_deleted: boolean }> => {
  const family = await findFamily(orgId, templateId)
  await materializeLegacyVersion(family)
  const v = await findVersion(orgId, templateId, version)
  // Một lần đổi mẫu chưa kết thúc đang trỏ tới bản này (bước áp dụng cần đọc file của nó)
  if (await TemplateMigration.exists({ "to.template_id": family._id, "to.version": version, open: true })) throw MIGRATION_IN_USE()
  const projectCount = await Project.countDocuments({ organizationId: orgId, "template_ref.template_id": family._id, "template_ref.version": version })
  await OrgTemplateVersion.deleteOne({ _id: v._id })
  await docFileStore().remove(v.file_ref).catch(() => undefined)
  const latest = await OrgTemplateVersion.findOne({ template_id: family._id, visibility: "org", status: "published" }).sort({ version: -1 }).select("version").lean()
  const remaining = await OrgTemplateVersion.countDocuments({ template_id: family._id })
  if (!remaining) {
    await OrgTemplate.deleteOne({ _id: family._id })
    return { deleted: true, project_count: projectCount, template_deleted: true }
  }
  await OrgTemplate.updateOne({ _id: family._id }, { $set: { latest_version: latest?.version ?? 0 } })
  return { deleted: true, project_count: projectCount, template_deleted: false }
}

/** Xoá cả họ mẫu cùng mọi bản + file. */
export const deleteFamily = async (orgId: string, templateId: string): Promise<{ deleted: true; project_count: number }> => {
  const family = await findFamily(orgId, templateId)
  if (await TemplateMigration.exists({ "to.template_id": family._id, open: true })) throw MIGRATION_IN_USE()
  const versions = await OrgTemplateVersion.find({ template_id: family._id, orgId }).select("file_ref").lean()
  const projectCount = await Project.countDocuments({ organizationId: orgId, "template_ref.template_id": family._id })
  await OrgTemplateVersion.deleteMany({ template_id: family._id, orgId })
  await OrgTemplate.deleteOne({ _id: family._id })
  const refs = [...versions.map((v) => v.file_ref), ...(family.file_ref ? [family.file_ref] : [])]
  await Promise.all(refs.map((r) => docFileStore().remove(r).catch(() => undefined)))
  return { deleted: true, project_count: projectCount }
}
