/**
 * Change request mode 1 — phần lõi: tạo (C-1, nút 3.1), đọc, chuyển trạng thái, nộp (3.11), sửa lại / đóng
 * (3.12–3.13), huỷ (3.10, UC-53). FLF-171, plan §6 2E.
 * AI (C-2, C-4, C-5) ở `clarify` / `propose` / `verify`; tìm vị trí + khoá ở `impact`; duyệt + ghi ở `decision` / `write`.
 */

import mongoose from "mongoose"
import { latestDocVersion } from "../doc-version/doc-version.service.js"
import { stripRecord } from "../import/check.service.js"
import { loadLayout, titleOfSection } from "../import/gap-report.service.js"
import { hasBaseline } from "../import/import.state.js"
import { latestImport, transitionImport } from "../import/import.service.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { toIso } from "../import/mode1.http.js"
import { formatCrId } from "./change-request.constants.js"
import type { ChangeRequestDetail, CreateChangeRequest } from "./change-request.dto.js"
import { ChangeRequest, CrCounter, type IChangeRequest } from "./change-request.model.js"
import { assertTransition, isTerminal, type CrStatus } from "./change-request.state.js"
import { ChangeGroup } from "./change-group.model.js"
import { ChangeLocation } from "./change-location.model.js"
import { regroup } from "./group.service.js"
import { lockPaths, unlockPaths } from "./lock.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { elementValue, valueText } from "./spine-location.js"

// ─── đọc ─────────────────────────────────────────────────────────

export const requireCr = async (projectId: string, crId: string): Promise<IChangeRequest> => {
  const cr = await ChangeRequest.findOne({ projectId, cr_id: crId })
  if (!cr) throw new Mode1Error("CR_NOT_FOUND", `Không tìm thấy ${crId}`)
  return cr
}

export const assertCrStatus = (cr: IChangeRequest, allowed: readonly CrStatus[], to: CrStatus): void => {
  if (!allowed.includes(cr.status)) {
    throw new Mode1Error("CR_INVALID_TRANSITION", `${cr.cr_id} đang ở "${cr.status}"`, { status: cr.status, to, allowed })
  }
}

export const transitionCr = async (cr: IChangeRequest, to: CrStatus): Promise<void> => {
  if (cr.status === to) return
  assertTransition(cr.status, to)
  cr.status = to
  await cr.save()
}

const toCrDto = (cr: IChangeRequest): ChangeRequestDetail["change_request"] => ({
  cr_id: cr.cr_id,
  project_id: String(cr.projectId),
  title: cr.title,
  description: cr.description,
  source: { kind: cr.source.kind, ref: cr.source.ref ?? null, note: cr.source.note ?? null },
  requester: cr.requester,
  status: cr.status,
  paused: cr.paused ? { reason: cr.paused.reason, at: toIso(cr.paused.at)! } : null,
  clarifications: cr.clarifications.map((c) => ({ round: c.round, questions: [...c.questions], answers: [...c.answers] })),
  base_doc_version: cr.base_doc_version,
  result_doc_version: cr.result_doc_version ?? null,
  created_by: String(cr.created_by),
  submitted_at: toIso(cr.submitted_at),
  decided_by: cr.decided_by ? String(cr.decided_by) : null,
  closed_reason: cr.closed_reason ?? null,
  created_at: toIso(cr.createdAt)!,
  updated_at: toIso(cr.updatedAt)!
})

export const pendingQuestions = (cr: IChangeRequest): string[] => {
  if (cr.status !== "awaiting_answers") return []
  const last = cr.clarifications[cr.clarifications.length - 1]
  return last && last.answers.length === 0 ? [...last.questions] : []
}

export const toDetail = async (cr: IChangeRequest): Promise<ChangeRequestDetail> => {
  const [locations, groups, record, layout] = await Promise.all([
    ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ location_id: 1 }).lean(),
    ChangeGroup.find({ projectId: cr.projectId, cr_id: cr.cr_id }).sort({ group_id: 1 }).lean(),
    spineRepository.get(String(cr.projectId)),
    loadLayout(String(cr.projectId))
  ])
  const spine = record ? stripRecord(record) : null
  return {
    change_request: toCrDto(cr),
    locations: locations.map((l) => {
      return {
        location_id: l.location_id,
        path: l.path,
        section_id: l.section_id,
        section_title: spine && l.section_id !== "misc" ? titleOfSection(spine, l.section_id, layout) : "",
        current_text: spine ? valueText(elementValue(spine, l.path)) : "",
        found_by: [...l.found_by],
        entity_paths: [...l.entity_paths],
        owner_step: l.owner_step ?? null,
        conclusion: l.conclusion ?? null,
        reason: l.reason ?? null,
        proposal: l.proposal
          ? { old_text: l.proposal.old_text, new_text: l.proposal.new_text ?? null, comment_text: l.proposal.comment_text ?? null, spine_ops: [...(l.proposal.spine_ops ?? [])] }
          : null,
        manual: l.manual,
        redo_count: l.redo_count,
        verify: l.verify
          ? {
              code_ok: l.verify.code_ok,
              violations: l.verify.violations.map((v) => ({ rule: v.rule, message: v.message, ...(v.path ? { path: v.path } : {}) })),
              ai_flags: l.verify.ai_flags.map((f) => ({ rule: f.rule, message: f.message })),
              at: toIso(l.verify.at)!
            }
          : null,
        group_id: l.group_id ?? null
      }
    }),
    groups: groups.map((g) => ({
      group_id: g.group_id,
      title: g.title,
      location_ids: [...g.location_ids],
      decision: g.decision,
      reason: g.reason ?? null,
      decided_by: g.decided_by ? String(g.decided_by) : null,
      decided_at: toIso(g.decided_at)
    })),
    pending_questions: pendingQuestions(cr)
  }
}

export const listCrs = async (projectId: string, status?: CrStatus): Promise<ChangeRequestDetail["change_request"][]> => {
  const filter: Record<string, unknown> = { projectId }
  if (status) filter.status = status
  const crs = await ChangeRequest.find(filter).sort({ createdAt: -1, _id: -1 })
  return crs.map(toCrDto)
}

// ─── C-1 tạo ─────────────────────────────────────────────────────

export const createCr = async (projectId: string, userId: string, body: CreateChangeRequest): Promise<IChangeRequest> => {
  const imported = await latestImport(projectId)
  const version = await latestDocVersion(projectId)
  if (!imported || !hasBaseline(imported.status) || !version) {
    throw new Mode1Error("CR_REQUIRES_BASELINE", "Chưa có baseline v0 — hoàn tất import trước khi tạo change request")
  }
  const counter = await CrCounter.findOneAndUpdate({ projectId }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" })
  const cr = await ChangeRequest.create({
    projectId,
    cr_id: formatCrId(counter.seq),
    title: body.title,
    description: body.description,
    source: body.source,
    requester: body.requester,
    status: "draft",
    base_doc_version: version.version,
    created_by: userId
  })
  if (imported.status === "gap_review" || imported.status === "delivered") await transitionImport(imported, "change_requested")
  return cr
}

// ─── 3.11 nộp, 3.12–3.13 sửa lại / đóng, 3.10 huỷ ───────────────

export const submitCr = async (cr: IChangeRequest): Promise<void> => {
  assertCrStatus(cr, ["ready_to_submit"], "in_review")
  const unconcluded = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id, conclusion: null }).distinct("location_id")
  if (unconcluded.length) {
    throw new Mode1Error("CR_LOCATION_UNCONCLUDED", `Còn ${unconcluded.length} vị trí chưa có kết luận`, { location_ids: unconcluded })
  }
  await regroup(cr)
  cr.submitted_at = new Date()
  await transitionCr(cr, "in_review")
}

/** Mọi group bị từ chối ⇒ khoá lại phần tử, bỏ đề xuất cũ, về đề xuất (3.6). */
export const reviseCr = async (cr: IChangeRequest): Promise<void> => {
  assertCrStatus(cr, ["in_review"], "proposing")
  const groups = await ChangeGroup.find({ projectId: cr.projectId, cr_id: cr.cr_id })
  if (groups.some((g) => g.decision !== "rejected")) {
    throw new Mode1Error("CR_INVALID_TRANSITION", "Chỉ sửa lại được khi mọi group đã bị từ chối", { status: cr.status, to: "proposing", allowed: [] })
  }
  const paths: string[] = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).distinct("path")
  await lockPaths(cr.projectId, cr.cr_id, paths)
  await ChangeGroup.deleteMany({ projectId: cr.projectId, cr_id: cr.cr_id })
  await ChangeLocation.updateMany(
    { projectId: cr.projectId, cr_id: cr.cr_id },
    { $set: { conclusion: null, reason: null, proposal: null, manual: false, redo_count: 0, verify: null, group_id: null } }
  )
  cr.submitted_at = null
  await transitionCr(cr, "proposing")
}

export const closeCr = async (cr: IChangeRequest, userId: string, reason: string): Promise<void> => {
  assertCrStatus(cr, ["in_review"], "rejected")
  cr.closed_reason = reason
  cr.decided_by = new mongoose.Types.ObjectId(userId)
  await transitionCr(cr, "rejected")
  await unlockPaths(cr.projectId, cr.cr_id)
}

export const cancelCr = async (cr: IChangeRequest, reason: string): Promise<void> => {
  if (isTerminal(cr.status)) assertTransition(cr.status, "cancelled")
  cr.closed_reason = reason
  cr.paused = null
  await transitionCr(cr, "cancelled")
  await unlockPaths(cr.projectId, cr.cr_id)
}
