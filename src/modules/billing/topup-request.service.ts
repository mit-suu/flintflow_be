/**
 * topup-request.service.ts — Analyst báo Lead nạp credit (FLF-332, BR-08).
 * ─────────────────────────────────────────────────────────────────
 * `requestTopup`: tạo (hoặc cập nhật) yêu cầu `open` của (org, user), báo in-app cho mọi Lead của org
 * (`credit_topup_requested`). Lead tự báo chính mình thì chỉ ghi yêu cầu, không tự nhận thông báo.
 * `fulfillTopupRequests`: gọi sau khi ví org được nạp (webhook thanh toán thành công, admin cộng credit) — đóng mọi
 * yêu cầu `open` của org và báo từng người đã yêu cầu (`credit_topped_up`). Step **không tự chạy**: thông báo chỉ dẫn
 * người dùng bấm tiếp tục (BR-08). Là side effect: lỗi chỉ log, không làm hỏng luồng nạp.
 */

import mongoose from "mongoose"
import { Membership } from "../organization/membership.model.js"
import { Organization } from "../organization/organization.model.js"
import { Project } from "../project/project.model.js"
import { User } from "../user/user.model.js"
import { notify } from "../notification/notification.service.js"
import { CreditWallet } from "../credits/credit-wallet.model.js"
import { ImportedDocument } from "../import/imported-document.model.js"
import { ChangeRequest } from "../change-request/change-request.model.js"
import { StepRun } from "../pipeline/run-state.model.js"
import { Spine } from "../spine/spine.model.js"
import { getStep, isPhaseUnit, isRegisteredStep, NONSCREEN_LOOP, orderedSteps, parseStepId } from "../pipeline/step-registry.js"
import { CreditTopupRequest, type ICreditTopupRequest } from "./credit-topup-request.model.js"

export interface TopupRequestInput {
  projectId?: string | null
  step?: string | null
  needed?: number | null
}

export interface TopupRequestDto {
  id: string
  organization_id: string
  user_id: string
  project_id: string | null
  step: string | null
  needed: number | null
  status: "open" | "fulfilled"
  /** Số Lead đã được báo (0 khi chính Lead tự báo). */
  notified_leads: number
  available: number
  created_at: string
  fulfilled_at: string | null
}

const toDto = (doc: ICreditTopupRequest, notifiedLeads: number, available: number): TopupRequestDto => ({
  id: String(doc._id),
  organization_id: String(doc.organizationId),
  user_id: String(doc.userId),
  project_id: doc.projectId ? String(doc.projectId) : null,
  step: doc.step ?? null,
  needed: doc.needed ?? null,
  status: doc.status,
  notified_leads: notifiedLeads,
  available,
  created_at: doc.createdAt.toISOString(),
  fulfilled_at: doc.fulfilledAt ? doc.fulfilledAt.toISOString() : null
})

const availableOf = async (orgId: string): Promise<number> => {
  const wallet = await CreditWallet.findOne({ organizationId: orgId }).lean()
  return wallet ? wallet.balance - wallet.reserved : 0
}

export const requestTopup = async (orgId: string, userId: string, input: TopupRequestInput = {}): Promise<TopupRequestDto> => {
  const projectId = input.projectId && mongoose.isValidObjectId(input.projectId) ? input.projectId : null
  // Một yêu cầu mở mỗi người mỗi org: bấm lại chỉ cập nhật step / số cần, Lead không bị dội thông báo trùng
  const existing = await CreditTopupRequest.findOne({ organizationId: orgId, userId, status: "open" })
  const doc =
    existing ??
    (await CreditTopupRequest.create({ organizationId: orgId, userId, projectId, step: input.step ?? null, needed: input.needed ?? null, status: "open" }))
  if (existing) {
    existing.projectId = projectId ? new mongoose.Types.ObjectId(projectId) : existing.projectId
    existing.step = input.step ?? existing.step
    existing.needed = input.needed ?? existing.needed
    await existing.save()
  }

  const [requester, org, project, leads, available] = await Promise.all([
    User.findById(userId).select("name email").lean(),
    Organization.findById(orgId).select("name").lean(),
    projectId ? Project.findById(projectId).select("name").lean() : null,
    Membership.find({ organizationId: orgId, role: "lead", userId: { $ne: userId } }).select("userId").lean(),
    availableOf(orgId)
  ])
  const who = requester?.name || requester?.email || "Một thành viên"
  const where = project ? ` ở dự án "${project.name}"` : ""
  const step = input.step ? ` (bước ${input.step})` : ""
  const needed = input.needed ? `, cần thêm khoảng ${input.needed} credit` : ""

  if (!existing) {
    await Promise.all(
      leads.map((m) =>
        notify(String(m.userId), {
          type: "credit_topup_requested",
          title: `${who} cần nạp credit cho ${org?.name ?? "tổ chức"}`,
          body: `Ví tổ chức còn ${available} credit khả dụng${where}${step}${needed}. Nạp thêm để bước AI chạy tiếp.`,
          link: "/home/billing",
          organizationId: orgId,
          meta: { organizationId: orgId, requestedBy: userId, projectId, step: input.step ?? null, needed: input.needed ?? null, available }
        })
      )
    )
  }
  return toDto(doc, existing ? 0 : leads.length, available)
}

interface TopupNotifyTarget {
  projectId: string | null
  step: string | null
}

const crStepLabel = (status: string, crId: string): string => {
  const prefix = status === "clarifying" ? "C-2" : status === "proposing" ? "C-4" : "C-5"
  return `${prefix}:${crId}`
}

const importStepLabel = (status: string, extractCursor: string | null | undefined): string =>
  status === "extracting" ? (extractCursor ? `I-4:${extractCursor}` : "I-4") : "I-1.11"

const unitOfStep = (step: { phase: string; loop: string | null }): string =>
  step.loop === null ? step.phase : `${step.phase}@${step.loop}`

const timestampMs = (value: unknown): number => {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") return Date.parse(value)
  return Number.NaN
}

interface PausedStepRunRow {
  projectId: mongoose.Types.ObjectId
  step_id?: string | null
  by?: string | null
  last_event_at?: Date | string | null
}

interface ActiveProjectInfo {
  _id: mongoose.Types.ObjectId
  userId?: mongoose.Types.ObjectId | null
  mode?: string | null
  converted_from?: string | null
}

/**
 * Lọc `StepRun` đang paused vì thiếu credit: bỏ dự án import đã convert từ FPT, step/đơn vị không có trong registry,
 * vòng màn `placeholder`/đã xoá, step đã `accepted`/`skipped`, và lượt phỏng vấn giai đoạn đã có decision hoặc bị vượt qua.
 */
const filterActionablePausedRuns = async (
  pausedRuns: readonly PausedStepRunRow[],
  projectById: ReadonlyMap<string, ActiveProjectInfo>
): Promise<readonly PausedStepRunRow[]> => {
  const candidates = pausedRuns.filter((run) => {
    const project = projectById.get(String(run.projectId))
    if (!project) return false
    if (project.mode === "import" && project.converted_from === "fpt") return false
    const stepId = run.step_id
    return Boolean(stepId && (isRegisteredStep(stepId) || isPhaseUnit(stepId)))
  })
  if (candidates.length === 0) return []

  const runProjectIds = Array.from(new Set(candidates.map((r) => String(r.projectId)))).map(
    (id) => new mongoose.Types.ObjectId(id)
  )

  const [spines, otherRuns] = await Promise.all([
    Spine.find({ projectId: { $in: runProjectIds } })
      .select("projectId steps screens functions decisions")
      .lean(),
    StepRun.find({ projectId: { $in: runProjectIds }, status: { $ne: "interrupted" } })
      .select("projectId step_id status last_event_at")
      .lean()
  ])

  const spineByProjectId = new Map(spines.map((s) => [String(s.projectId), s]))
  const otherRunsByProjectId = new Map<string, typeof otherRuns>()
  for (const r of otherRuns) {
    const key = String(r.projectId)
    const list = otherRunsByProjectId.get(key)
    if (list) list.push(r)
    else otherRunsByProjectId.set(key, [r])
  }

  return candidates.filter((run) => {
    const projectId = String(run.projectId)
    const stepId = run.step_id!
    const spine = spineByProjectId.get(projectId)
    const runTs = timestampMs(run.last_event_at)

    if (spine) {
      const { loop } = parseStepId(stepId)
      const screens = spine.screens ?? []
      if (loop && loop !== NONSCREEN_LOOP) {
        if (screens.some((s) => s.id === loop && s.detail_status === "placeholder")) return false
        if (screens.length > 0 && !screens.some((s) => s.id === loop)) return false
      }

      const stepMap = new Map((spine.steps ?? []).map((s) => [s.id, s]))
      if (isRegisteredStep(stepId)) {
        const status = stepMap.get(stepId)?.status
        if (status === "accepted" || status === "skipped") return false
      } else {
        if ((spine.decisions ?? []).some((d) => d.step_id === stepId && d.superseded_by === null)) return false

        const placeholders = new Set(screens.filter((s) => s.detail_status === "placeholder").map((s) => s.id))
        const unitSteps = orderedSteps({ screens: screens as any, functions: (spine.functions ?? []) as any }).filter(
          (s) => unitOfStep(s) === stepId && (s.loop === null || !placeholders.has(s.loop))
        )
        if (
          unitSteps.length > 0 &&
          unitSteps.every((s) => {
            const st = stepMap.get(s.id)?.status
            return st === "accepted" || st === "skipped"
          })
        ) {
          return false
        }
        if (
          Number.isFinite(runTs) &&
          unitSteps.some((s) => timestampMs(stepMap.get(s.id)?.accepted_at) > runTs)
        ) {
          return false
        }
      }
    }

    if (isPhaseUnit(stepId)) {
      const siblingRuns = otherRunsByProjectId.get(projectId) ?? []
      const bypassed = siblingRuns.some((other) => {
        if (!isRegisteredStep(other.step_id)) return false
        if (unitOfStep(getStep(other.step_id)) !== stepId) return false
        if (Number.isFinite(runTs)) return timestampMs(other.last_event_at) > runTs
        return other.status === "done" || other.status === "gate" || other.status === "running" || other.status === "waiting_answer"
      })
      if (bypassed) return false
    }

    return true
  })
}

/**
 * Thu thập tác giả các bước đang dừng vì thiếu credit trong các dự án còn hoạt động của org
 * (mode 1 `ImportedDocument`, `ChangeRequest`, và mode 2 `StepRun`), ghi nhận target đầu tiên cho mỗi user.
 */
const collectPausedAuthorTargets = async (
  orgObjectId: mongoose.Types.ObjectId,
  addTarget: (userId: string | undefined, target: TopupNotifyTarget) => void
): Promise<void> => {
  const projects = await Project.find({ organizationId: orgObjectId, deletedAt: null, status: { $ne: "archived" } })
    .select("_id userId mode converted_from")
    .lean()
  if (projects.length === 0) return

  const projectIds = projects.map((p) => p._id)
  const projectById = new Map<string, ActiveProjectInfo>(projects.map((p) => [String(p._id), p]))
  const projectOwnerByProjectId = new Map<string, string>(
    projects.filter((p) => p.userId).map((p) => [String(p._id), String(p.userId)])
  )

  const [pausedDocs, pausedCrs, pausedRuns] = await Promise.all([
    ImportedDocument.find({
      projectId: { $in: projectIds },
      "paused.reason": "credits",
      status: { $in: ["extracting", "checking"] }
    })
      .select("projectId status extract_cursor created_by")
      .lean(),
    ChangeRequest.find({
      projectId: { $in: projectIds },
      "paused.reason": "credits",
      status: { $in: ["clarifying", "proposing", "verifying"] }
    })
      .select("projectId cr_id status created_by")
      .lean(),
    StepRun.find({
      projectId: { $in: projectIds },
      status: "interrupted",
      "error.code": "INSUFFICIENT_CREDIT"
    })
      .select("projectId step_id by last_event_at")
      .lean()
  ])

  const actionableRuns = await filterActionablePausedRuns(pausedRuns, projectById)

  for (const doc of pausedDocs) {
    const projectId = String(doc.projectId)
    const authorId = doc.created_by ? String(doc.created_by) : projectOwnerByProjectId.get(projectId)
    addTarget(authorId, { projectId, step: importStepLabel(doc.status, doc.extract_cursor) })
  }

  for (const cr of pausedCrs) {
    const projectId = String(cr.projectId)
    const authorId = cr.created_by ? String(cr.created_by) : projectOwnerByProjectId.get(projectId)
    addTarget(authorId, { projectId, step: crStepLabel(cr.status, cr.cr_id) })
  }

  for (const run of actionableRuns) {
    const projectId = String(run.projectId)
    const authorId = run.by && mongoose.isValidObjectId(run.by) ? String(run.by) : projectOwnerByProjectId.get(projectId)
    addTarget(authorId, { projectId, step: run.step_id ?? null })
  }
}

/** Ví org vừa được nạp `credits` ⇒ đóng yêu cầu mở, báo mọi thành viên có yêu cầu hoặc bước dừng vì thiếu credit. */
export const fulfillTopupRequests = async (orgId: string, credits: number, by: { kind: "payment" | "admin"; userId?: string | null }): Promise<number> => {
  if (!mongoose.isValidObjectId(orgId) || credits <= 0) return 0
  try {
    const orgObjectId = new mongoose.Types.ObjectId(orgId)
    const open = await CreditTopupRequest.find({ organizationId: orgObjectId, status: "open" })
    if (open.length > 0) {
      const now = new Date()
      await CreditTopupRequest.updateMany(
        { _id: { $in: open.map((r) => r._id) } },
        { $set: { status: "fulfilled", fulfilledAt: now, fulfilledCredits: credits } }
      )
    }

    const targetsByUserId = new Map<string, TopupNotifyTarget>()
    const addTarget = (userId: string | undefined, target: TopupNotifyTarget) => {
      if (!userId || targetsByUserId.has(userId)) return
      targetsByUserId.set(userId, target)
    }

    for (const r of open) {
      addTarget(String(r.userId), {
        projectId: r.projectId ? String(r.projectId) : null,
        step: r.step ?? null
      })
    }

    await collectPausedAuthorTargets(orgObjectId, addTarget)
    if (targetsByUserId.size === 0) return 0

    const candidateObjectIds = [...targetsByUserId.keys()]
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id))
    if (candidateObjectIds.length === 0) return 0

    const activeMemberships = await Membership.find({
      organizationId: orgObjectId,
      userId: { $in: candidateObjectIds },
      role: { $in: ["lead", "analyst"] }
    })
      .select("userId")
      .lean()
    const eligibleUserIds = new Set(activeMemberships.map((m) => String(m.userId)))
    const eligibleTargets = [...targetsByUserId.entries()].filter(([targetUserId]) => eligibleUserIds.has(targetUserId))
    if (eligibleTargets.length === 0) return 0

    const recipients = eligibleTargets.filter(
      ([targetUserId]) => !(by.kind === "payment" && targetUserId === (by.userId ?? ""))
    )
    if (recipients.length > 0) {
      const available = await availableOf(orgId)
      await Promise.all(
        recipients.map(([targetUserId, target]) =>
          notify(targetUserId, {
            type: "credit_topped_up",
            title: `Tổ chức đã được nạp ${credits} credit`,
            body: `${by.kind === "admin" ? "Quản trị viên" : "Lead"} đã nạp ${credits} credit, ví còn ${available} credit khả dụng. Mở lại dự án và bấm tiếp tục - bước đang dừng không tự chạy.`,
            link: target.projectId ? `/projects/${target.projectId}` : "/home/billing",
            organizationId: orgId,
            meta: { organizationId: orgId, credits, available, projectId: target.projectId, step: target.step }
          })
        )
      )
    }
    return eligibleTargets.length
  } catch (err) {
    console.warn("[billing] không đóng được yêu cầu nạp credit sau khi nạp:", err)
    return 0
  }
}
