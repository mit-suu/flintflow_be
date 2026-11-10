/**
 * FLF-395 (D12, D13) — dự án mẫu tự do có baseline ⇒ tự lưu **khung** thành mẫu tổ chức; heading chưa chắc an toàn chờ duyệt.
 *
 * Gọi ở mọi nơi tạo baseline (finalize 0.1, chuyển từ mode 2, phát hành) với file của chính bản vừa tạo — khung theo tài liệu
 * lúc phát hành (mục riêng thêm / bỏ qua CR làm khung đổi ⇒ bản mới). Chỉ khi dự án thuộc org, có file nền, và không theo mẫu
 * do Lead đăng. Trùng khung đã có (kể cả heading còn chờ) ⇒ không lưu, gắn dự án vào bản đó; khung đổi sau đó ⇒ dự án có họ
 * khung riêng. Lỗi không bao giờ chặn baseline / phát hành.
 */
import { createHash } from "node:crypto"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { Membership, type OrgRole } from "../organization/membership.model.js"
import { notify } from "../notification/notification.service.js"
import { Project, type IProject } from "../project/project.model.js"
import { documentLanguageOf } from "../project/document-language.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost } from "../../shared/ai/credit-reservation.service.js"
import type { SkeletonGenericNamesOutput } from "../../shared/ai/response-parser.js"
import { withMeteredAi } from "./metered-ai.js"
import { normalizeTitle } from "./org-mapping.js"
import { OrgTemplate, OrgTemplateVersion, type IOrgTemplate, type IOrgTemplateVersion, type SkeletonPendingHeading } from "./org-library.model.js"
import { createDraftVersion, deleteFamily, publishVersion, type TemplateActor } from "./org-template-versions.service.js"
import { TemplateProfile } from "./template-profile.model.js"
import { buildSkeleton, genericSuggestion, type BuiltSkeleton, type PendingDecision, type SkeletonOptions } from "./template-skeleton.js"

const NAME_MAX = 120

/** Tên mặc định theo ngôn ngữ tài liệu (chốt 10/11): VI `<tên dự án> — khung`, EN `<tên dự án> — template`. */
export const skeletonName = (projectName: string, language: "vi" | "en"): string => {
  const suffix = language === "vi" ? " — khung" : " — template"
  return `${projectName.trim().slice(0, NAME_MAX - suffix.length)}${suffix}`
}

/** Bản sao thuần (subdocument Mongoose không spread được). */
const plainPending = (p: SkeletonPendingHeading): SkeletonPendingHeading => ({
  key: p.key,
  heading_text: p.heading_text,
  level: p.level,
  kind: p.kind ?? "custom",
  standard_title: p.standard_title ?? null,
  suggestion: p.suggestion ?? null,
  suggestion_reason: p.suggestion_reason ?? null,
  decision: p.decision,
  generic_text: p.generic_text ?? null
})

const toDecision = (p: SkeletonPendingHeading): PendingDecision | null =>
  p.decision === "keep" || p.decision === "drop" ? { decision: p.decision } : p.decision === "generic" ? { decision: "generic", text: p.generic_text ?? p.heading_text } : null

const decisionsOf = (pending: readonly SkeletonPendingHeading[]): Map<string, PendingDecision> =>
  new Map(
    pending.flatMap((p): [string, PendingDecision][] => {
      const d = toDecision(p)
      return d ? [[p.key, d]] : []
    })
  )

/** Quyết định đã có ở bản trước (theo heading chuẩn hoá) ⇒ áp sang file mới, người duyệt không phải duyệt lại. */
const carriedDecisions = (previous: readonly SkeletonPendingHeading[], review: BuiltSkeleton["review"]): Map<string, PendingDecision> => {
  const byTitle = new Map<string, PendingDecision>()
  for (const p of previous) {
    const d = toDecision(p)
    if (d) byTitle.set(normalizeTitle(p.heading_text), d)
  }
  return new Map(review.flatMap((r): [string, PendingDecision][] => {
    const d = byTitle.get(normalizeTitle(r.heading_text))
    return d ? [[r.key, d]] : []
  }))
}

/** Danh sách lưu trên bản: mọi heading cần duyệt, kèm quyết định đã có. */
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
      decision: d?.decision ?? "pending",
      generic_text: d?.decision === "generic" ? d.text : null
    }
  })

const pendingCount = (v: Pick<IOrgTemplateVersion, "pending_headings">) => v.pending_headings.filter((p) => p.decision === "pending").length

interface SkeletonContext {
  project: IProject
  orgId: string
  opts: SkeletonOptions
  /** Bản khung dự án đang theo (của chính nó hoặc dùng chung với dự án khác cùng khung). */
  boundVersion: IOrgTemplateVersion | null
  /** Họ khung của chính dự án — khung đổi ⇒ bản mới trong họ này. */
  ownFamily: IOrgTemplate | null
}

const contextOf = async (projectId: string): Promise<SkeletonContext | null> => {
  const project = await Project.findById(projectId)
  // Chỉ dự án mẫu tự do (D12, chốt 10/11): dự án theo mẫu bắt buộc không tự lưu khung
  if (!project?.organizationId || project.template_intent === "fixed") return null
  const profile = await TemplateProfile.findOne({ projectId }).select("language source_file_ref").lean()
  // Không có file nền (mode 2 sinh theo mẫu FPT) ⇒ không tự lưu (chốt 10/11)
  if (!profile?.source_file_ref) return null
  const orgId = String(project.organizationId)
  let boundVersion: IOrgTemplateVersion | null = null
  let ownFamily: IOrgTemplate | null = null
  if (project.template_ref) {
    const family = await OrgTemplate.findOne({ _id: project.template_ref.template_id, orgId })
    // Đang theo mẫu do Lead đăng ⇒ không tự lưu khung
    if (family && !family.skeleton_of) return null
    if (family) {
      boundVersion = await OrgTemplateVersion.findOne({ template_id: family._id, version: project.template_ref.version })
      if (String(family.skeleton_of) === String(project._id)) ownFamily = family
    }
  }
  if (!ownFamily) ownFamily = await OrgTemplate.findOne({ orgId, skeleton_of: project._id })
  return { project, orgId, opts: { projectName: project.name, language: documentLanguageOf(project, profile.language) }, boundVersion, ownFamily }
}

const notifyPending = async (ctx: SkeletonContext, family: IOrgTemplate, count: number): Promise<void> => {
  if (!count) return
  const members = await Membership.find({ organizationId: ctx.orgId, role: { $in: ["lead", "analyst"] } }).select("userId").lean()
  await Promise.all(
    members.map((m) =>
      notify(String(m.userId), {
        type: "skeleton_headings_pending",
        title: `Có ${count} mục chờ duyệt cho mẫu khung "${family.name}"`,
        body: `Mục do BA tự đặt hoặc tên mục khác tên chuẩn ở dự án "${ctx.project.name}" chỉ vào mẫu của tổ chức sau khi được duyệt (giữ nguyên, giữ dạng chung hoặc bỏ).`,
        link: `/projects/${String(ctx.project._id)}`,
        organizationId: ctx.orgId,
        meta: { template_id: String(family._id), project_id: String(ctx.project._id), pending: count }
      })
    )
  )
}

const bindProject = (projectId: string, templateId: unknown, version: number) =>
  Project.updateOne({ _id: projectId }, { $set: { template_ref: { template_id: templateId, version } } })

/**
 * Điểm gắn ở mọi nơi tạo baseline. `sourceRef` = file của bản vừa tạo (0.1 / 1.0 / bản phát hành); `userId` = người tạo baseline
 * (ghi `created_by` của bản khung). Không ném lỗi.
 */
export const autoSaveSkeleton = async (projectId: string, userId: string, sourceRef: string): Promise<void> => {
  let createdFamily: IOrgTemplate | null = null
  let draftId: unknown = null
  try {
    const ctx = await contextOf(projectId)
    if (!ctx) return
    const source = await docFileStore().load(sourceRef)
    const first = await buildSkeleton(source, ctx.opts)
    const decided = carriedDecisions(ctx.boundVersion?.pending_headings ?? [], first.review)
    const built = decided.size ? await buildSkeleton(source, ctx.opts, decided) : first
    if (built.empty) return
    if (ctx.boundVersion?.skeleton_hash === built.hash) return

    const same = await OrgTemplateVersion.findOne({ orgId: ctx.orgId, skeleton_hash: built.hash, visibility: "org", status: "published" }).sort({ version: -1 })
    if (same) {
      await bindProject(projectId, same.template_id, same.version)
      return
    }

    const actor: TemplateActor = { userId, role: "system" }
    const family =
      ctx.ownFamily ??
      (createdFamily = await OrgTemplate.create({ orgId: ctx.orgId, name: skeletonName(ctx.opts.projectName, ctx.opts.language), created_by: userId, latest_version: 0, skeleton_of: ctx.project._id }))
    const draft = await createDraftVersion(ctx.orgId, actor, family, { buffer: built.buffer, originalname: `${family.name}.docx`, size: built.buffer.length }, {
      headings: built.headings,
      table_map: built.table_map,
      language: ctx.opts.language,
      template_family: null
    })
    draftId = draft._id
    const pending = pendingList(built, decided, ctx.opts)
    await OrgTemplateVersion.updateOne({ _id: draft._id }, { $set: { skeleton_hash: built.hash, skeleton_source_ref: sourceRef, pending_headings: pending } })
    await publishVersion(ctx.orgId, actor, String(family._id), draft.version, [], { skipProjectIds: [projectId] })
    await bindProject(projectId, family._id, draft.version)
    await notifyPending(ctx, family, pendingCount({ pending_headings: pending }))
  } catch (error) {
    console.error(`[OrgTemplate] tự lưu khung mẫu cho dự án ${projectId} lỗi (bỏ qua, không chặn baseline):`, error)
    // Không để họ / bản nháp dở dang trong thư viện
    if (createdFamily) await deleteFamily(String(createdFamily.orgId), String(createdFamily._id)).catch(() => undefined)
    else if (draftId) {
      const draft = await OrgTemplateVersion.findOneAndDelete({ _id: draftId, status: "draft" }).catch(() => null)
      if (draft) await docFileStore().remove(draft.file_ref).catch(() => undefined)
    }
  }
}

// ─── duyệt heading ───────────────────────────────────────────────

export interface PendingView {
  template_id: string
  name: string
  version: number
  pending_count: number
  headings: SkeletonPendingHeading[]
  /** Credit một lượt "Gợi ý tên chung" (theo bảng giá hiện hành) — FE báo trước khi gọi. */
  suggest_credit_cost: number
}

const CAN_REVIEW: ReadonlySet<string> = new Set(["lead", "analyst"])

/** Bản khung dự án đang theo — chỉ khung của chính dự án mới duyệt được ở dự án. */
const ownSkeleton = async (projectId: string, orgId: string): Promise<{ project: IProject; family: IOrgTemplate; version: IOrgTemplateVersion } | null> => {
  const project = await Project.findOne({ _id: projectId, organizationId: orgId })
  if (!project?.template_ref) return null
  const family = await OrgTemplate.findOne({ _id: project.template_ref.template_id, orgId, skeleton_of: project._id })
  if (!family) return null
  const version = await OrgTemplateVersion.findOne({ template_id: family._id, orgId, version: project.template_ref.version })
  return version ? { project, family, version } : null
}

const viewOf = async (family: IOrgTemplate, v: IOrgTemplateVersion): Promise<PendingView> => ({
  template_id: String(family._id),
  name: family.name,
  version: v.version,
  pending_count: pendingCount(v),
  headings: v.pending_headings.map(plainPending),
  suggest_credit_cost: await getActionCost(ActionType.SKELETON_GENERIC_NAMES)
})

export const getPendingHeadings = async (projectId: string, orgId: string): Promise<PendingView | null> => {
  const own = await ownSkeleton(projectId, orgId)
  return own ? viewOf(own.family, own.version) : null
}

const NO_SKELETON = () => new ApiError(404, "Dự án chưa có mẫu khung tự lưu.", "SKELETON_NOT_FOUND")
const assertReviewer = (role: OrgRole) => {
  if (!CAN_REVIEW.has(role)) throw new ApiError(403, "Chỉ Lead hoặc Analyst duyệt mục của mẫu khung.", "ORG_ROLE_FORBIDDEN")
}

export interface HeadingDecisionInput {
  key: string
  decision: "keep" | "generic" | "drop"
  generic_text?: string
}

const optsOf = async (project: IProject): Promise<SkeletonOptions> => {
  const profile = await TemplateProfile.findOne({ projectId: project._id }).select("language").lean()
  return { projectName: project.name, language: documentLanguageOf(project, profile?.language) }
}

/**
 * Lead / Analyst duyệt heading chờ ⇒ dựng lại file khung từ đúng file nguồn của bản, cập nhật bản đang dùng (không đổi số).
 * Hai người duyệt cùng lúc ⇒ người sau nhận 409.
 */
export const decidePendingHeadings = async (projectId: string, orgId: string, role: OrgRole, inputs: readonly HeadingDecisionInput[]): Promise<PendingView> => {
  assertReviewer(role)
  const own = await ownSkeleton(projectId, orgId)
  if (!own?.version.skeleton_source_ref) throw NO_SKELETON()
  const pending = own.version.pending_headings.map(plainPending)
  for (const input of inputs) {
    const target = pending.find((p) => p.key === input.key)
    if (!target) throw new ApiError(400, "Mục cần duyệt không có trong mẫu khung.", "VALIDATION_ERROR", { field: "decisions" })
    const text = input.decision === "generic" ? (input.generic_text ?? target.suggestion ?? "").trim() : ""
    if (input.decision === "generic" && !text) throw new ApiError(400, "Cần nhập tên chung cho mục này.", "VALIDATION_ERROR", { field: "generic_text" })
    target.decision = input.decision
    target.generic_text = input.decision === "generic" ? text : null
  }
  const opts = await optsOf(own.project)
  const built = await buildSkeleton(await docFileStore().load(own.version.skeleton_source_ref), opts, decisionsOf(pending))
  // Mục lồng trong mục vừa được giữ có thể mới lộ ra ⇒ thêm vào danh sách chờ
  const known = new Set(pending.map((p) => p.key))
  const next = [...pending, ...pendingList(built, new Map(), opts).filter((p) => !known.has(p.key))]
  const fileRef = await docFileStore().save(built.buffer, { projectId: `org-${orgId}`, kind: "upload", name: own.version.source_file.name })
  const updated = await OrgTemplateVersion.findOneAndUpdate(
    { _id: own.version._id, updatedAt: own.version.updatedAt },
    {
      $set: {
        file_ref: fileRef,
        "source_file.size": built.buffer.length,
        "source_file.sha256": createHash("sha256").update(built.buffer).digest("hex"),
        headings: built.headings,
        table_map: built.table_map,
        skeleton_hash: built.hash,
        pending_headings: next
      }
    },
    { returnDocument: "after", runValidators: true }
  )
  if (!updated) {
    await docFileStore().remove(fileRef).catch(() => undefined)
    throw new ApiError(409, "Mẫu khung vừa được người khác duyệt — tải lại để xem.", "SKELETON_CONFLICT")
  }
  await docFileStore().remove(own.version.file_ref).catch(() => undefined)
  return viewOf(own.family, updated)
}

/**
 * Nút "Gợi ý tên chung" (D13): một lượt AI cho mọi mục còn chờ, giữ credit trước (BR-01), chỉ chạy khi người dùng bấm. Chỉ ghi
 * gợi ý cho mục **vẫn còn chờ** lúc ghi — quyết định ai đó vừa đưa ra trong lúc chờ AI không bị xoá.
 */
export const suggestGenericNames = async (projectId: string, orgId: string, userId: string, role: OrgRole): Promise<PendingView> => {
  assertReviewer(role)
  const own = await ownSkeleton(projectId, orgId)
  if (!own) throw NO_SKELETON()
  const waiting = own.version.pending_headings.filter((p) => p.decision === "pending")
  if (!waiting.length) return viewOf(own.family, own.version)
  const opts = await optsOf(own.project)
  const result = await withMeteredAi<SkeletonGenericNamesOutput>({ projectId, userId, stepId: `SKELETON:${String(own.version._id)}` }, ActionType.SKELETON_GENERIC_NAMES, {
    project_name: own.project.name,
    language: opts.language === "vi" ? "Vietnamese" : "English",
    headings: waiting.map((p) => `${p.key}: ${p.heading_text}`).join("\n")
  })
  if (!result.ok) {
    if (result.reason === "credits") throw new ApiError(402, result.userMessage, "INSUFFICIENT_CREDIT")
    throw new ApiError(502, result.userMessage, "SKELETON_SUGGEST_FAILED", { reason: result.reason })
  }
  const known = new Set(waiting.map((p) => p.key))
  // Một gợi ý mỗi khoá (AI trả trùng khoá ⇒ lấy cái đầu; hai arrayFilter khớp cùng một phần tử thì Mongo báo xung đột)
  const suggestions = [...new Map(result.data.suggestions.filter((s) => known.has(s.key)).reverse().map((s) => [s.key, s] as const)).values()]
  if (suggestions.length) {
    const set: Record<string, unknown> = {}
    const arrayFilters: Record<string, unknown>[] = []
    suggestions.forEach((s, i) => {
      set[`pending_headings.$[k${i}].suggestion`] = s.generic ?? null
      set[`pending_headings.$[k${i}].suggestion_reason`] = s.reason ?? null
      arrayFilters.push({ [`k${i}.key`]: s.key, [`k${i}.decision`]: "pending" })
    })
    await OrgTemplateVersion.updateOne({ _id: own.version._id }, { $set: set }, { arrayFilters })
  }
  const fresh = await OrgTemplateVersion.findById(own.version._id)
  return viewOf(own.family, fresh ?? own.version)
}
