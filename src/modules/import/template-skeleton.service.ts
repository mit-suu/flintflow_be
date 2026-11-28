/**
 * UC-85 / UC-88 - sau mỗi baseline của dự án có file nền, đề xuất lưu **khung** (heading cấu trúc, tiêu đề cột, chữ hướng dẫn) thành
 * mẫu tổ chức. Khung dựng bằng `buildSkeleton`; AI đổi mọi tên riêng ở heading BA tự đặt thành chỗ trống (trừ credit, BR-01). Đề
 * xuất **chưa** vào thư viện: tác giả baseline chọn trên thẻ (Analyst: Send to Lead; Lead: Save to library; Don't save), Lead duyệt
 * đề xuất Analyst gửi (Approve / Reject). Lead cũng lưu cấu trúc dự án bất cứ lúc nào theo cùng luật.
 *
 * Không đề xuất khi: không có file nền (dự án tạo không file theo mẫu chuẩn), khung trùng bản đang theo / trùng mẫu org có sẵn (gắn dự
 * án vào bản đó), cấu trúc từng bị bỏ / từ chối, thiếu credit hoặc AI lỗi (lần phát hành sau đề xuất lại). Lỗi không bao giờ chặn
 * baseline / phát hành.
 */
import mongoose from "mongoose"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { DocVersion } from "../doc-version/doc-version.model.js"
import { Membership, type OrgRole } from "../organization/membership.model.js"
import { notify } from "../notification/notification.service.js"
import { Project, type IProject } from "../project/project.model.js"
import { documentLanguageOf } from "../project/document-language.js"
import { User } from "../user/user.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { SkeletonGenericNamesOutput } from "../../shared/ai/response-parser.js"
import { withMeteredAi } from "./metered-ai.js"
import { normalizeTitle } from "./org-mapping.js"
import { OrgTemplate, OrgTemplateVersion, type IOrgTemplate, type IOrgTemplateVersion, type SkeletonPendingHeading } from "./org-library.model.js"
import { createDraftVersion, deleteFamily, publishVersion, type TemplateActor } from "./org-template-versions.service.js"
import { TemplateProfile } from "./template-profile.model.js"
import {
  CLOSED_FOR_GOOD,
  OPEN_STATUSES,
  TemplateProposal,
  type ITemplateProposal,
  type ProposalDecision,
  type ProposalReplacedName,
  type ProposalTextReplacement,
  type TemplateProposalStatus
} from "./template-proposal.model.js"
import { buildSkeleton, genericSuggestion, type BuiltSkeleton, type PendingDecision, type ReviewHeading, type ScrubText, type SkeletonOptions } from "./template-skeleton.js"
import { isValidScrub } from "./skeleton-scrub.js"

const NAME_MAX = 120

/** Tên mặc định theo ngôn ngữ tài liệu: VI `<tên dự án> - mẫu`, EN `<tên dự án> - template` (gạch ngắn, không em dash, chữ hiện trên UI). */
export const skeletonName = (projectName: string, language: "vi" | "en"): string => {
  const suffix = language === "vi" ? " - mẫu" : " - template"
  return `${projectName.trim().slice(0, NAME_MAX - suffix.length)}${suffix}`
}

const toDecision = (p: { decision: string; generic_text?: string | null; heading_text?: string }): PendingDecision | null =>
  p.decision === "keep" || p.decision === "drop" ? { decision: p.decision } : p.decision === "generic" ? { decision: "generic", text: p.generic_text ?? p.heading_text ?? "" } : null

const decisionsOf = (list: readonly ProposalDecision[]): Map<string, PendingDecision> =>
  new Map(
    list.flatMap((p): [string, PendingDecision][] => {
      const d = toDecision(p)
      return d ? [[p.key, d]] : []
    })
  )

/** Quyết định đã có ở bản khung trước (theo heading chuẩn hoá) ⇒ áp sang baseline mới, không gọi AI lại cho mục đó. */
const carriedDecisions = (previous: readonly SkeletonPendingHeading[], review: BuiltSkeleton["review"]): Map<string, PendingDecision> => {
  const byTitle = new Map<string, PendingDecision>()
  for (const p of previous) {
    const d = toDecision(p)
    if (d) byTitle.set(normalizeTitle(p.heading_text), d)
  }
  return new Map(
    review.flatMap((r): [string, PendingDecision][] => {
      const d = byTitle.get(normalizeTitle(r.heading_text))
      return d ? [[r.key, d]] : []
    })
  )
}

/** Danh sách lưu trên bản khung: mọi heading BA tự đặt kèm quyết định - để baseline sau mang sang (`carriedDecisions`). */
const pendingList = (built: BuiltSkeleton, decided: ReadonlyMap<string, PendingDecision>, opts: SkeletonOptions): SkeletonPendingHeading[] =>
  built.review.map((h): SkeletonPendingHeading => {
    const d = decided.get(h.key)
    return {
      key: h.key,
      heading_text: h.heading_text,
      level: h.level,
      kind: h.kind,
      standard_title: h.standard_title,
      suggestion: genericSuggestion(h.heading_text, opts.projectName, opts.language),
      suggestion_reason: null,
      decision: d?.decision ?? "keep",
      generic_text: d?.decision === "generic" ? d.text : null
    }
  })

/** Một lượt AI đổi tên riêng cho heading + chữ hướng dẫn + tiêu đề cột; chữ khách đưa vào dưới dạng chuỗi JSON (dữ liệu, không phải lệnh). */
const scrubWithAi = async (
  meter: { projectId: string; userId: string; stepId: string },
  ctx: Pick<SkeletonContext, "project" | "opts">,
  headings: readonly { key: string; text: string; current?: string | null }[],
  texts: readonly { key: string; text: string; current?: string | null }[],
  instruction = ""
): Promise<{ ok: true; byKey: Map<string, string | null> } | { ok: false; reason: "credits" | "resume_later" }> => {
  const line = (e: { key: string; text: string; current?: string | null }) => `${e.key}: ${JSON.stringify(e.current && e.current !== e.text ? { text: e.text, current: e.current } : e.text)}`
  const result = await withMeteredAi<SkeletonGenericNamesOutput>(meter, ActionType.SKELETON_GENERIC_NAMES, {
    project_name: ctx.project.name,
    language: ctx.opts.language === "vi" ? "Vietnamese" : "English",
    headings: headings.map(line).join("\n") || "(none)",
    texts: texts.map(line).join("\n") || "(none)",
    instruction
  })
  if (!result.ok) return { ok: false, reason: result.reason }
  return { ok: true, byKey: new Map(result.data.suggestions.map((s) => [s.key, s.generic] as const)) }
}

/** Các chỗ AI đã đổi (heading có quyết định `generic`, chữ hướng dẫn / tiêu đề cột) để người duyệt xem trước. */
const replacedOf = (
  review: readonly ReviewHeading[],
  texts: readonly ScrubText[],
  decisions: ReadonlyMap<string, PendingDecision>,
  textRepl: ReadonlyMap<string, string>,
  previous: readonly ProposalReplacedName[]
): ProposalReplacedName[] => {
  const reasonOf = (key: string) => previous.find((p) => p.key === key)?.reason ?? null
  const out: ProposalReplacedName[] = []
  for (const r of review) {
    const d = decisions.get(r.key)
    if (d?.decision === "generic") out.push({ key: r.key, original: r.heading_text, generic: d.text, reason: reasonOf(r.key), kind: "heading" })
  }
  for (const t of texts) {
    const g = textRepl.get(t.text)
    if (g) out.push({ key: t.key, original: t.text, generic: g, reason: reasonOf(t.key), kind: t.kind })
  }
  return out
}

const textReplacementsOf = (texts: readonly ScrubText[], textRepl: ReadonlyMap<string, string>): ProposalTextReplacement[] =>
  texts.flatMap((t) => (textRepl.has(t.text) ? [{ key: t.key, original: t.text, generic: textRepl.get(t.text)! }] : []))

const sameHeadings = (a: readonly { heading_text: string }[], b: readonly { heading_text: string }[]): boolean =>
  a.length === b.length && a.every((h, i) => normalizeTitle(h.heading_text) === normalizeTitle(b[i].heading_text))

interface SkeletonContext {
  project: IProject
  orgId: string
  opts: SkeletonOptions
  /** Bản khung lưu từ dự án mà dự án đang theo (của chính nó hoặc dùng chung). */
  boundVersion: IOrgTemplateVersion | null
  /** Bản mẫu do Lead đăng mà dự án đang theo - cấu trúc trùng ⇒ không đề xuất. */
  leadVersion: IOrgTemplateVersion | null
}

const contextOf = async (projectId: string): Promise<SkeletonContext | null> => {
  const project = await Project.findById(projectId)
  if (!project?.organizationId) return null
  const profile = await TemplateProfile.findOne({ projectId }).select("language source_file_ref").lean()
  // Không có file nền (dự án tạo không file theo mẫu chuẩn FlintFlow) ⇒ không đề xuất (AUC UC-85)
  if (!profile?.source_file_ref) return null
  const orgId = String(project.organizationId)
  let boundVersion: IOrgTemplateVersion | null = null
  let leadVersion: IOrgTemplateVersion | null = null
  if (project.template_ref) {
    const family = await OrgTemplate.findOne({ _id: project.template_ref.template_id, orgId })
    if (family) {
      const version = await OrgTemplateVersion.findOne({ template_id: family._id, version: project.template_ref.version })
      if (family.skeleton_of) boundVersion = version
      else leadVersion = version
    }
  }
  return { project, orgId, opts: { projectName: project.name, language: documentLanguageOf(project, profile.language) }, boundVersion, leadVersion }
}

const bindProject = (projectId: string, templateId: unknown, version: number) =>
  Project.updateOne({ _id: projectId }, { $set: { template_ref: { template_id: templateId, version } } })

const notifyLeads = async (orgId: string, exceptUserId: string, payload: Parameters<typeof notify>[1]): Promise<void> => {
  const leads = await Membership.find({ organizationId: orgId, role: "lead", userId: { $ne: exceptUserId } }).select("userId").lean()
  await Promise.all(leads.map((m) => notify(String(m.userId), payload)))
}

/** Lý do không có đề xuất mới - FE báo cho Lead khi bấm "Save structure as template". */
export type NoProposalReason = "no_base_file" | "same_structure" | "declined_before" | "empty" | "ai_unavailable"

type DraftResult = { proposal: ITemplateProposal } | { reason: NoProposalReason }

/**
 * Dựng đề xuất từ file `sourceRef` (baseline / bản phát hành). `authorId` = người tạo baseline (người duy nhất thấy thẻ).
 * Không ném lỗi nghiệp vụ - trả lý do khi không đề xuất.
 */
const draftProposal = async (ctx: SkeletonContext, sourceRef: string, authorId: string): Promise<DraftResult> => {
  const projectId = String(ctx.project._id)
  const source = await docFileStore().load(sourceRef)
  const first = await buildSkeleton(source, ctx.opts)
  const carried = carriedDecisions(ctx.boundVersion?.pending_headings ?? [], first.review)
  const base = carried.size ? await buildSkeleton(source, ctx.opts, carried) : first
  if (base.empty) return { reason: "empty" }
  // Khoá cấu trúc = hash khung gốc, trước mọi quyết định đổi tên (mang từ bản trước hay của AI) - quyết định khác nhau giữa các
  // lần không làm "cùng cấu trúc" thành "khác"
  const structureHash = first.hash
  if (ctx.boundVersion?.skeleton_hash === structureHash) return { reason: "same_structure" }
  if (ctx.leadVersion && sameHeadings(base.headings, ctx.leadVersion.headings)) return { reason: "same_structure" }

  // Cấu trúc trùng mẫu org đã lưu từ dự án khác ⇒ không đề xuất, dự án theo bản đó
  const same = await OrgTemplateVersion.findOne({ orgId: ctx.orgId, skeleton_hash: structureHash, visibility: "org", status: "published" }).sort({ version: -1 })
  if (same) {
    await bindProject(projectId, same.template_id, same.version)
    return { reason: "same_structure" }
  }
  if (await TemplateProposal.exists({ project_id: projectId, structure_hash: structureHash, status: { $in: CLOSED_FOR_GOOD } })) return { reason: "declined_before" }
  const open = await TemplateProposal.findOne({ project_id: projectId, structure_hash: structureHash, status: { $in: OPEN_STATUSES } })
  if (open) return { proposal: open }

  // AI đổi tên riêng ở heading chưa có quyết định + chữ hướng dẫn + tiêu đề cột (một lượt, giữ credit trước - BR-01)
  const decisions = new Map(carried)
  const undecided = base.review.filter((r) => !decisions.has(r.key))
  const textRepl = new Map<string, string>()
  let built = base
  if (undecided.length || base.texts.length) {
    const result = await scrubWithAi(
      { projectId, userId: authorId, stepId: `TEMPLATE_PROPOSAL:${projectId}` },
      ctx,
      undecided.map((r) => ({ key: r.key, text: r.heading_text })),
      base.texts.map((t) => ({ key: t.key, text: t.text }))
    )
    // Thiếu credit / AI lỗi ⇒ không đề xuất lần này, lần phát hành sau đề xuất lại
    if (!result.ok) return { reason: "ai_unavailable" }
    for (const r of undecided) {
      const s = result.byKey.get(r.key)
      // Không bỏ heading: đầu ra sai dạng / không đổi ⇒ giữ chữ gốc cho người xem lại
      if (s && isValidScrub(r.heading_text, s) && s.trim() !== r.heading_text.trim()) decisions.set(r.key, { decision: "generic", text: s.trim() })
      else decisions.set(r.key, { decision: "keep" })
    }
    for (const t of base.texts) {
      const s = result.byKey.get(t.key)
      if (s && isValidScrub(t.text, s) && s.trim() !== t.text.trim()) textRepl.set(t.text, s.trim())
    }
    built = await buildSkeleton(source, ctx.opts, decisions, textRepl)
    if (built.empty) return { reason: "empty" }
  }
  const replaced = replacedOf(built.review, built.texts, decisions, textRepl, [])

  // Baseline mới thay đề xuất còn mở của cấu trúc cũ
  await TemplateProposal.updateMany({ project_id: projectId, status: { $in: OPEN_STATUSES } }, { $set: { status: "superseded" } })
  const proposal = await TemplateProposal.create({
    orgId: ctx.orgId,
    project_id: projectId,
    source_ref: sourceRef,
    structure_hash: structureHash,
    decisions: [...decisions].map(([key, d]) => ({ key, decision: d.decision, generic_text: d.decision === "generic" ? d.text : null })),
    replaced_names: replaced,
    text_replacements: textReplacementsOf(built.texts, textRepl),
    headings: built.headings.map((h) => ({ heading_text: h.heading_text })),
    status: "proposed",
    created_by: authorId
  })
  return { proposal }
}

/**
 * Điểm gắn ở mọi nơi tạo baseline (finalize 0.1, chuyển từ mode 2, phát hành). `sourceRef` = file của bản vừa tạo; `userId` = người
 * tạo baseline. Không ném lỗi.
 */
export const proposeTemplateFromBaseline = async (projectId: string, userId: string, sourceRef: string): Promise<void> => {
  try {
    const ctx = await contextOf(projectId)
    if (ctx) await draftProposal(ctx, sourceRef, userId)
  } catch (error) {
    console.error(`[OrgTemplate] đề xuất mẫu cho dự án ${projectId} lỗi (bỏ qua, không chặn baseline):`, error)
  }
}

/** Đăng khung của đề xuất vào thư viện (họ khung của dự án, bản kế tiếp), dự án nguồn theo bản đó. */
const publishProposal = async (proposal: ITemplateProposal, actor: TemplateActor): Promise<{ template_id: string; version: number }> => {
  const project = await Project.findById(proposal.project_id)
  if (!project) throw new ApiError(404, "Không tìm thấy dự án của đề xuất.", "PROJECT_NOT_FOUND")
  const orgId = String(proposal.orgId)
  const profile = await TemplateProfile.findOne({ projectId: project._id }).select("language").lean()
  const opts: SkeletonOptions = { projectName: project.name, language: documentLanguageOf(project, profile?.language) }
  const decided = decisionsOf(proposal.decisions)
  const textRepl = new Map(proposal.text_replacements.map((t) => [t.original, t.generic] as const))
  const built = await buildSkeleton(await docFileStore().load(proposal.source_ref), opts, decided, textRepl)
  let createdFamily: IOrgTemplate | null = null
  let draftId: unknown = null
  try {
    const family =
      (await OrgTemplate.findOne({ orgId, skeleton_of: project._id })) ??
      (createdFamily = await OrgTemplate.create({ orgId, name: skeletonName(opts.projectName, opts.language), created_by: actor.userId, latest_version: 0, skeleton_of: project._id }))
    const draft = await createDraftVersion(orgId, actor, family, { buffer: built.buffer, originalname: `${family.name}.docx`, size: built.buffer.length }, {
      headings: built.headings,
      table_map: built.table_map,
      language: opts.language,
      template_family: null
    })
    draftId = draft._id
    await OrgTemplateVersion.updateOne(
      { _id: draft._id },
      { $set: { skeleton_hash: proposal.structure_hash, skeleton_source_ref: proposal.source_ref, pending_headings: pendingList(built, decided, opts) } }
    )
    await publishVersion(orgId, actor, String(family._id), draft.version, [], { skipProjectIds: [String(project._id)] })
    await bindProject(String(project._id), family._id, draft.version)
    return { template_id: String(family._id), version: draft.version }
  } catch (error) {
    // Không để họ / bản nháp dở dang trong thư viện
    if (createdFamily) await deleteFamily(orgId, String(createdFamily._id)).catch(() => undefined)
    else if (draftId) {
      const draft = await OrgTemplateVersion.findOneAndDelete({ _id: draftId, status: "draft" }).catch(() => null)
      if (draft) await docFileStore().remove(draft.file_ref).catch(() => undefined)
    }
    throw error
  }
}

// ─── API ─────────────────────────────────────────────────────────

export interface ProposalView {
  id: string
  project_id: string
  project_name: string
  status: TemplateProposalStatus
  headings: string[]
  replaced_names: ProposalReplacedName[]
  created_by: { id: string; name: string | null }
  created_at: string
  template_id: string | null
  version: number | null
}

const viewOf = async (p: ITemplateProposal): Promise<ProposalView> => {
  const [project, author] = await Promise.all([
    Project.findById(p.project_id).select("name").lean(),
    User.findById(p.created_by).select("name email").lean()
  ])
  return {
    id: String(p._id),
    project_id: String(p.project_id),
    project_name: project?.name ?? "",
    status: p.status,
    headings: p.headings.map((h) => h.heading_text),
    replaced_names: p.replaced_names.map((r) => ({ key: r.key, original: r.original, generic: r.generic ?? null, reason: r.reason ?? null, kind: r.kind ?? "heading" })),
    created_by: { id: String(p.created_by), name: author?.name || author?.email || null },
    created_at: p.createdAt.toISOString(),
    template_id: p.template_id ? String(p.template_id) : null,
    version: p.version ?? null
  }
}

const NOT_FOUND = () => new ApiError(404, "Không có đề xuất mẫu nào đang chờ.", "TEMPLATE_PROPOSAL_NOT_FOUND")
const CHANGED = () => new ApiError(409, "Đề xuất vừa được xử lý ở nơi khác - tải lại để xem.", "TEMPLATE_PROPOSAL_CONFLICT")
const FORBIDDEN = (message: string) => new ApiError(403, message, "ORG_ROLE_FORBIDDEN")

/** Thẻ đề xuất của dự án - chỉ tác giả baseline thấy; `null` khi không có. */
export const getProposalForAuthor = async (projectId: string, userId: string): Promise<ProposalView | null> => {
  const p = await TemplateProposal.findOne({ project_id: projectId, created_by: userId, status: { $in: OPEN_STATUSES } }).sort({ createdAt: -1 })
  return p ? viewOf(p) : null
}

/** Đề xuất `proposed` của tác giả ⇒ chuyển trạng thái nguyên tử (hai tab bấm cùng lúc ⇒ tab sau nhận 409). */
const claimOwn = async (projectId: string, userId: string, set: Record<string, unknown>): Promise<ITemplateProposal> => {
  const current = await TemplateProposal.findOne({ project_id: projectId, created_by: userId, status: "proposed" }).sort({ createdAt: -1 })
  if (!current) throw NOT_FOUND()
  const claimed = await TemplateProposal.findOneAndUpdate({ _id: current._id, status: "proposed" }, { $set: set }, { returnDocument: "after" })
  if (!claimed) throw CHANGED()
  return claimed
}

/** Người sửa đề xuất qua chat: Lead hoặc Analyst (Viewer không). */
export const assertReviewer = (role: OrgRole): void => {
  if (role !== "lead" && role !== "analyst") throw FORBIDDEN("Chỉ Lead hoặc Analyst sửa đề xuất mẫu.")
}

/** Đề xuất `proposed` do chính người này tạo, của dự án thuộc đúng org đang mở. */
const ownSkeleton = async (projectId: string, orgId: string, userId: string): Promise<{ project: IProject; proposal: ITemplateProposal }> => {
  if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  const project = await Project.findOne({ _id: projectId, organizationId: orgId })
  if (!project) throw new ApiError(404, "Không tìm thấy dự án hoặc bạn không có quyền truy cập.", "PROJECT_NOT_FOUND")
  const proposal = await TemplateProposal.findOne({ project_id: projectId, orgId, created_by: userId, status: "proposed" }).sort({ createdAt: -1 })
  if (!proposal) throw NOT_FOUND()
  return { project, proposal }
}

export const REVISE_MESSAGE_MAX = 500

/**
 * Sửa đề xuất qua chat (UC-85): người dùng nói điều muốn đổi ("giữ tên X ở mục 3", "đổi thêm tên Y"), AI trả lại chữ cho từng chỗ,
 * code chỉ nhận chữ qua kiểm diff (`isValidScrub`). Giữ credit trước mỗi lượt; thiếu credit / AI lỗi ⇒ đề xuất giữ nguyên.
 */
export const reviseProposal = async (projectId: string, orgId: string, userId: string, role: OrgRole, message: string): Promise<ProposalView> => {
  assertReviewer(role)
  const instruction = message.trim()
  if (!instruction || instruction.length > REVISE_MESSAGE_MAX) throw new ApiError(400, `Nội dung sửa phải từ 1 đến ${REVISE_MESSAGE_MAX} ký tự.`, "VALIDATION_ERROR", { field: "message" })
  const { project, proposal } = await ownSkeleton(projectId, orgId, userId)
  const profile = await TemplateProfile.findOne({ projectId }).select("language").lean()
  const opts: SkeletonOptions = { projectName: project.name, language: documentLanguageOf(project, profile?.language) }
  const source = await docFileStore().load(proposal.source_ref)
  const decisions = new Map(decisionsOf(proposal.decisions))
  const textRepl = new Map(proposal.text_replacements.map((t) => [t.original, t.generic] as const))
  const current = await buildSkeleton(source, opts, decisions, textRepl)
  const headingEntries = current.review.map((r) => {
    const d = decisions.get(r.key)
    return { key: r.key, text: r.heading_text, current: d?.decision === "generic" ? d.text : null }
  })
  const textEntries = current.texts.map((t) => ({ key: t.key, text: t.text, current: textRepl.get(t.text) ?? null }))
  const result = await scrubWithAi({ projectId, userId, stepId: `TEMPLATE_PROPOSAL_CHAT:${projectId}` }, { project, opts }, headingEntries, textEntries, instruction)
  if (!result.ok) {
    throw result.reason === "credits"
      ? new ApiError(402, "Không đủ credit để AI sửa đề xuất.", "INSUFFICIENT_CREDIT")
      : new ApiError(503, "AI đang lỗi, đề xuất giữ nguyên - thử lại sau.", "TEMPLATE_PROPOSAL_AI_UNAVAILABLE")
  }
  for (const r of current.review) {
    const s = result.byKey.get(r.key)
    if (!s || !isValidScrub(r.heading_text, s)) continue
    decisions.set(r.key, s.trim() === r.heading_text.trim() ? { decision: "keep" } : { decision: "generic", text: s.trim() })
  }
  for (const t of current.texts) {
    const s = result.byKey.get(t.key)
    if (!s || !isValidScrub(t.text, s)) continue
    if (s.trim() === t.text.trim()) textRepl.delete(t.text)
    else textRepl.set(t.text, s.trim())
  }
  const built = await buildSkeleton(source, opts, decisions, textRepl)
  if (built.empty) throw new ApiError(409, "Khung không còn heading nào để lưu.", "TEMPLATE_PROPOSAL_UNAVAILABLE", { reason: "empty" })
  const updated = await TemplateProposal.findOneAndUpdate(
    { _id: proposal._id, status: "proposed" },
    {
      $set: {
        decisions: [...decisions].map(([key, d]) => ({ key, decision: d.decision, generic_text: d.decision === "generic" ? d.text : null })),
        replaced_names: replacedOf(built.review, built.texts, decisions, textRepl, proposal.replaced_names),
        text_replacements: textReplacementsOf(built.texts, textRepl),
        headings: built.headings.map((h) => ({ heading_text: h.heading_text }))
      }
    },
    { returnDocument: "after" }
  )
  if (!updated) throw CHANGED()
  return viewOf(updated)
}

/** Analyst gửi đề xuất cho Lead duyệt (UC-85 ⇒ UC-88). Lead thì dùng Save to library. */
export const sendProposal = async (projectId: string, orgId: string, userId: string, role: OrgRole): Promise<ProposalView> => {
  if (role !== "analyst") throw FORBIDDEN("Chỉ Analyst gửi đề xuất cho Lead; Lead lưu thẳng vào thư viện.")
  const p = await claimOwn(projectId, userId, { status: "sent", sent_by: userId })
  const view = await viewOf(p)
  await notifyLeads(orgId, userId, {
    type: "template_proposal_submitted",
    title: `Đề xuất mẫu từ dự án "${view.project_name}" chờ bạn duyệt`,
    body: `${view.created_by.name ?? "Analyst"} đề xuất lưu cấu trúc dự án thành mẫu của tổ chức.`,
    link: `/home/library?proposal=${view.id}`,
    organizationId: orgId,
    meta: { proposal_id: view.id, project_id: view.project_id, project_name: view.project_name, proposer_name: view.created_by.name }
  })
  return view
}

/** Lead (tác giả baseline) lưu thẳng vào thư viện; dự án theo mẫu vừa lưu. */
export const saveProposal = async (projectId: string, userId: string, role: OrgRole): Promise<ProposalView> => {
  if (role !== "lead") throw FORBIDDEN("Chỉ Lead lưu đề xuất vào thư viện mẫu.")
  const p = await claimOwn(projectId, userId, { status: "approved", decided_by: userId, decided_at: new Date() })
  return finishApproval(p, { userId, role: "lead" })
}

/** Don't save ⇒ không lưu; cùng cấu trúc không đề xuất lại. */
export const declineProposal = async (projectId: string, userId: string): Promise<ProposalView> =>
  viewOf(await claimOwn(projectId, userId, { status: "declined", decided_by: userId, decided_at: new Date() }))

/** Đăng sau khi đã giành trạng thái `approved`; đăng lỗi ⇒ trả trạng thái cũ để thử lại. */
const finishApproval = async (p: ITemplateProposal, actor: TemplateActor, previous: TemplateProposalStatus = "proposed"): Promise<ProposalView> => {
  try {
    const published = await publishProposal(p, actor)
    const done = await TemplateProposal.findByIdAndUpdate(p._id, { $set: { template_id: published.template_id, version: published.version } }, { returnDocument: "after" })
    return viewOf(done ?? p)
  } catch (error) {
    await TemplateProposal.updateOne({ _id: p._id, status: "approved" }, { $set: { status: previous, decided_by: null, decided_at: null } })
    throw error
  }
}

const latestBaselineFile = async (projectId: string): Promise<string | null> => {
  const v = await DocVersion.findOne({ projectId }).sort({ createdAt: -1 }).select("clean_file_ref file_ref").lean()
  return v ? (v.clean_file_ref ?? v.file_ref ?? null) : null
}

/** Lead lưu cấu trúc dự án làm mẫu bất cứ lúc nào (cùng luật UC-85): dựng đề xuất từ bản mới nhất, Lead là tác giả. */
export const createProposalNow = async (projectId: string, userId: string, role: OrgRole): Promise<ProposalView> => {
  if (role !== "lead") throw FORBIDDEN("Chỉ Lead lưu cấu trúc dự án thành mẫu.")
  const ctx = await contextOf(projectId)
  if (!ctx) throw new ApiError(409, "Dự án không có file nền nên không lưu cấu trúc thành mẫu được.", "TEMPLATE_PROPOSAL_UNAVAILABLE", { reason: "no_base_file" })
  const sourceRef = await latestBaselineFile(projectId)
  if (!sourceRef) throw new ApiError(409, "Dự án chưa có bản baseline nào để lưu cấu trúc.", "TEMPLATE_PROPOSAL_UNAVAILABLE", { reason: "empty" })
  const result = await draftProposal(ctx, sourceRef, userId)
  if ("reason" in result) {
    const message: Record<NoProposalReason, string> = {
      no_base_file: "Dự án không có file nền nên không lưu cấu trúc thành mẫu được.",
      same_structure: "Cấu trúc này đã có trong thư viện mẫu của tổ chức.",
      declined_before: "Cấu trúc này đã bị bỏ hoặc bị từ chối trước đây.",
      empty: "Tài liệu không có heading nào để lưu thành mẫu.",
      ai_unavailable: "Chưa đổi được tên riêng (thiếu credit hoặc AI đang lỗi) - thử lại sau."
    }
    throw new ApiError(409, message[result.reason], "TEMPLATE_PROPOSAL_UNAVAILABLE", { reason: result.reason })
  }
  // Đề xuất cùng cấu trúc do người khác tạo đang mở ⇒ Lead duyệt nó ở Thư viện mẫu
  if (String(result.proposal.created_by) !== userId) {
    throw new ApiError(409, "Cấu trúc này đang có đề xuất chờ duyệt - mở Thư viện mẫu để duyệt.", "TEMPLATE_PROPOSAL_UNAVAILABLE", { reason: "pending", proposal_id: String(result.proposal._id) })
  }
  return viewOf(result.proposal)
}

// ─── Lead duyệt (UC-88) ──────────────────────────────────────────

export const listSentProposals = async (orgId: string): Promise<ProposalView[]> => {
  const list = await TemplateProposal.find({ orgId, status: "sent" }).sort({ createdAt: -1 }).limit(100)
  return Promise.all(list.map(viewOf))
}

const sentProposal = async (orgId: string, proposalId: string): Promise<ITemplateProposal> => {
  if (!mongoose.isValidObjectId(proposalId)) throw NOT_FOUND()
  const p = await TemplateProposal.findOne({ _id: proposalId, orgId })
  if (!p) throw NOT_FOUND()
  return p
}

export const getProposal = async (orgId: string, proposalId: string): Promise<ProposalView> => viewOf(await sentProposal(orgId, proposalId))

const notifyProposer = async (p: ITemplateProposal, view: ProposalView, approved: boolean): Promise<void> => {
  await notify(String(p.sent_by ?? p.created_by), {
    type: approved ? "template_proposal_approved" : "template_proposal_rejected",
    title: approved ? `Lead đã lưu mẫu từ dự án "${view.project_name}"` : `Lead chưa lưu mẫu từ dự án "${view.project_name}"`,
    body: approved ? "Cấu trúc dự án đã vào thư viện mẫu của tổ chức, dự án theo mẫu đó." : "Dự án tiếp tục không có mẫu; bạn có thể tự áp một mẫu sau.",
    link: `/projects/${view.project_id}`,
    organizationId: String(p.orgId),
    meta: { proposal_id: view.id, project_id: view.project_id, project_name: view.project_name }
  })
}

export const approveProposal = async (orgId: string, proposalId: string, actor: TemplateActor): Promise<ProposalView> => {
  const p = await sentProposal(orgId, proposalId)
  const claimed = await TemplateProposal.findOneAndUpdate(
    { _id: p._id, status: "sent" },
    { $set: { status: "approved", decided_by: actor.userId, decided_at: new Date() } },
    { returnDocument: "after" }
  )
  if (!claimed) throw CHANGED()
  const view = await finishApproval(claimed, actor, "sent")
  await notifyProposer(claimed, view, true)
  return view
}

export const rejectProposal = async (orgId: string, proposalId: string, userId: string): Promise<ProposalView> => {
  const p = await sentProposal(orgId, proposalId)
  const claimed = await TemplateProposal.findOneAndUpdate(
    { _id: p._id, status: "sent" },
    { $set: { status: "rejected", decided_by: userId, decided_at: new Date() } },
    { returnDocument: "after" }
  )
  if (!claimed) throw CHANGED()
  const view = await viewOf(claimed)
  await notifyProposer(claimed, view, false)
  return view
}
