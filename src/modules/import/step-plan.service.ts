/**
 * Kế hoạch step theo template (#32–#33, mode 1 v2 — FLF-183). Đọc / bật / tắt step; trạng thái step ở Spine đi kèm:
 * bật step ẩn ⇒ `skipped` → `pending` (chạy được trong workspace); tắt step đã bật chưa có dữ liệu ⇒ `pending` → `skipped`.
 * Không tắt được step `applied` (đầu mục mẫu FPT — D6 — hoặc bước luôn chạy) và step đã có dữ liệu ⇒ 409 CORE_STEP_REQUIRED.
 */

import { ApiError } from "../../shared/utils/api-error.js"
import { nextStep } from "../pipeline/step-registry.js"
import { applyTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import * as spineRepository from "../spine/spine.repository.js"
import { stripRecord } from "./check.service.js"
import type { StepPlanEntry, StepPlanPatchRequest } from "./import.dto.js"
import { Mode1Error } from "./mode1.errors.js"
import { TemplateProfile, type StepPlanItem } from "./template-profile.model.js"

const toDto = (items: StepPlanItem[]): { steps: StepPlanEntry[] } => ({
  steps: items.map((i) => ({ step_id: i.step_id, state: i.state, missing: i.missing, section_ids: [...i.section_ids], reason: i.reason }))
})

const requirePlan = async (projectId: string) => {
  const profile = await TemplateProfile.findOne({ projectId })
  if (!profile || !profile.step_plan?.length) {
    throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa có kế hoạch step — hoàn tất import (finalize) trước", { status: null, to: "checking", allowed: [] })
  }
  return profile
}

export const getStepPlan = async (projectId: string) => toDto((await requirePlan(projectId)).step_plan)

export const patchStepPlan = async (projectId: string, userId: string, body: StepPlanPatchRequest) => {
  const profile = await requirePlan(projectId)
  const item = profile.step_plan.find((s) => s.step_id === body.step_id)
  if (!item) throw new Mode1Error("STEP_NOT_IN_PLAN", `Step ${body.step_id} không có trong kế hoạch của dự án`)

  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)
  const state = spine.steps.find((s) => s.id === item.step_id)

  let status: "pending" | "skipped" | null = null
  if (body.enabled && item.state === "hidden") {
    item.state = "enabled"
    item.reason = "Người dùng bật thêm"
    status = "pending"
  } else if (!body.enabled && item.state !== "hidden") {
    if (item.state === "applied") throw new Mode1Error("CORE_STEP_REQUIRED", `Step ${item.step_id} thuộc đầu mục mẫu FPT hoặc luôn chạy — không tắt được`, { step_id: item.step_id })
    const hasData = !!state && (state.status !== "pending" && state.status !== "skipped" || state.first_seq !== null)
    if (hasData) throw new Mode1Error("CORE_STEP_REQUIRED", `Step ${item.step_id} đã có dữ liệu — không tắt được`, { step_id: item.step_id })
    item.state = "hidden"
    item.reason = "Người dùng tắt"
    status = "skipped"
  }
  if (status === null) return toDto(profile.step_plan)

  const ops: Op[] = state
    ? [{ op: "set", path: `steps[id=${item.step_id}].status`, value: status }]
    : [{ op: "add", path: "steps[]", value: { id: item.step_id, status, first_seq: null, last_seq: null, accepted_at: null } }]
  const after = {
    ...spine,
    steps: state ? spine.steps.map((s) => (s.id === item.step_id ? { ...s, status } : s)) : [...spine.steps, { id: item.step_id, status, first_seq: null, last_seq: null, accepted_at: null }]
  }
  const next = nextStep(after)
  ops.push({ op: "set", path: "progress.current_phase", value: next?.phase ?? null }, { op: "set", path: "progress.current_step", value: next?.id ?? null })
  await applyTransaction(projectId, { base_version: record.spine_version, ops, by: userId, reason: `Kế hoạch step: ${body.enabled ? "bật" : "tắt"} ${item.step_id}`, step_id: null })

  profile.markModified("step_plan")
  await profile.save()
  return toDto(profile.step_plan)
}
