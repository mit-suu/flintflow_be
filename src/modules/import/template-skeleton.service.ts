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
  type TemplateProposalStatus
} from "./template-proposal.model.js"
import { buildSkeleton, genericSuggestion, type BuiltSkeleton, type PendingDecision, type SkeletonOptions } from "./template-skeleton.js"

const NAME_MAX = 120

/** Tên mặc định theo ngôn ngữ tài liệu: VI `<tên dự án> - khung`, EN `<tên dự án> - template` (gạch ngắn, chữ hiện trên UI). */
export const skeletonName = (projectName: string, language: "vi" | "en"): string => {
  const suffix = language === "vi" ? " - khung" : " - template"
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

  // AI đổi tên riêng ở heading BA tự đặt chưa có quyết định (một lượt, giữ credit trước - BR-01)
  const decisions = new Map(carried)
  const replaced: ProposalReplacedName[] = []
  const undecided = base.review.filter((r) => !decisions.has(r.key))
  let built = base
  if (undecided.length) {
    const result = await withMeteredAi<SkeletonGenericNamesOutput>({ projectId, userId: authorId, stepId: `TEMPLATE_PROPOSAL:${projectId}` }, ActionType.SKELETON_GENERIC_NAMES, {
      project_name: ctx.project.name,
      language: ctx.opts.language === "vi" ? "Vietnamese" : "English",
      headings: undecided.map((r) => `${r.key}: ${r.heading_text}`).join("\n")
    })
    // Thiếu credit / AI lỗi ⇒ không đề xuất lần này, lần phát hành sau đề xuất lại
    if (!result.ok) return { reason: "ai_unavailable" }
    const byKey = new Map(result.data.suggestions.map((s) => [s.key, s] as const))
    for (const r of undecided) {
      const s = byKey.get(r.key)
      if (!s) continue
      if (s.generic === null) {
        decisions.set(r.key, { decision: "drop" })
        replaced.push({ key: r.key, original: r.heading_text, generic: null, reason: s.reason ?? null })
      } else if (s.generic.trim() && s.generic.trim() !== r.heading_text.trim()) {
        decisions.set(r.key, { decision: "generic", text: s.generic.trim() })
        replaced.push({ key: r.key, original: r.heading_text, generic: s.generic.trim(), reason: s.reason ?? null })
      } else decisions.set(r.key, { decision: "keep" })
    }
    built = await buildSkeleton(source, ctx.opts, decisions)
    if (built.empty) return { reason: "empty" }
  }

  // Baseline mới thay đề xuất còn mở của cấu trúc cũ
  await TemplateProposal.updateMany({ project_id: projectId, status: { $in: OPEN_STATUSES } }, { $set: { status: "superseded" } })
  const proposal = await TemplateProposal.create({
    orgId: ctx.orgId,
    project_id: projectId,
    source_ref: sourceRef,
    structure_hash: structureHash,
    decisions: [...decisions].map(([key, d]) => ({ key, decision: d.decision, generic_text: d.decision === "generic" ? d.text : null })),
    replaced_names: replaced,
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
  const built = await buildSkeleton(await docFileStore().load(proposal.source_ref), opts, decided)
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
    replaced_names: p.replaced_names.map((r) => ({ key: r.key, original: r.original, generic: r.generic ?? null, reason: r.reason ?? null })),
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
