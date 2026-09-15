/**
 * gate.service.ts
 * ─────────────────────────────────────────────────────────────────
 * 4 hành động cổng chốt (Phases §3, `assets/skills/action/gate-check/SKILL.md`): accept, revision,
 * regenerate, accept_as_is. Trần 8 lượt gọi model/step, 3 regenerate/step — xem `meter.service.ts`.
 *
 * `POST /steps/:stepId/gate` KHÔNG stream (khác `/run`): mọi việc chạy đồng bộ, trả `gateResponseSchema`.
 * `revision`/`regenerate` tái dùng `runDraftPhase`/`runRenderReviewPhase` của `step-runner.service.ts`
 * với `emit` no-op.
 *
 * B7 (F6, review T13): step đã `accepted` được PHÉP quay lại qua `revision`/`regenerate` — chuyển
 * `status = revision_requested`, reset `first_seq/last_seq/accepted_at` (vòng mới, F1) rồi mới redraft.
 * `accept`/`accept_as_is` trên step đã accepted vẫn bị chặn (vô nghĩa — step đã ở đích).
 */

import { applyTransaction, revertRange } from "../spine/op-engine.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Flag, Spine, SpineRecord, StepState } from "../spine/spine.types.js"
import type { Op } from "../spine/op.types.js"
import { getStep, nextStep as nextStepOf, orderedSteps } from "./step-registry.js"
import { buildStepContext, parseStepId, sectionsFedBy } from "./context-projection.js"
import * as meter from "./meter.service.js"
import {
  runDraftPhase,
  runRenderReviewPhase,
  trackSeqRange,
  assertRangeOwnedByStep,
  acquireStepLock,
  releaseStepLock,
  CALLS_LIMIT,
  REGENERATE_LIMIT_COUNT,
  STEP_NOT_RUNNABLE,
  defaultStepRunnerDeps,
  type StepRunnerDeps
} from "./step-runner.service.js"
import { gateActionSchema } from "./pipeline.dto.js"
import { notify } from "../../modules/notification/notification.service.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { z } from "zod"

type GateActionKind = z.infer<typeof gateActionSchema>

export const REGENERATE_LIMIT = "REGENERATE_LIMIT"
export const CALL_LIMIT = "CALL_LIMIT"

/** 409 với `meta` cho FE (contract §0.3: `{ regenerate_used: 3 }` / `{ calls_used: 8 }`). */
export class GateLimitError extends ApiError {
  readonly details: Record<string, number>
  constructor(code: typeof REGENERATE_LIMIT | typeof CALL_LIMIT, message: string, details: Record<string, number>) {
    super(409, message, code)
    this.details = details
  }
}

export interface GateInput {
  action: GateActionKind
  note?: string
  base_version: number
  function_id?: string
}

export interface StepSummary {
  id: string
  phase: string
  label_vi: string
  label_en: string
  kind: "soft" | "fixed" | "loop" | "gate"
  status: StepState["status"]
  deterministic: boolean
  calls_used: number
  calls_limit: 8
  regenerate_used: number
  regenerate_limit: 3
  accepted_at: string | null
}

export interface GateResult {
  step: StepSummary
  next_step: string | null
  spine_version: number
}

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

const load = async (projectId: string): Promise<SpineRecord> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  return record
}

const usageCounts = meter.roundCounts

const buildSummary = (spine: Spine, stepId: string, counts: { calls_used: number; regenerate_used: number }): StepSummary => {
  const def = getStep(stepId)
  const state = spine.steps.find((s) => s.id === stepId)
  return {
    id: stepId,
    phase: def.phase,
    label_vi: def.label_vi,
    label_en: def.label_en,
    kind: def.kind,
    status: state?.status ?? "pending",
    deterministic: def.deterministic,
    calls_used: counts.calls_used,
    calls_limit: CALLS_LIMIT,
    regenerate_used: counts.regenerate_used,
    regenerate_limit: REGENERATE_LIMIT_COUNT,
    accepted_at: state?.accepted_at ?? null
  }
}

/** `S-5.5` accept ⇒ `screens[id=<loop>].detail_status = signed_off` (task 13, Phases §4.3). */
const signOffOps = (stepId: string): Op[] => {
  const step = getStep(stepId)
  if (step.template_id !== "S-5.5" || step.loop === null || step.loop === "nonscreen") return []
  return [{ op: "set", path: `screens[id=${step.loop}].detail_status`, value: "signed_off" }]
}

const phaseFullyAccepted = (spine: Spine, phase: string): boolean =>
  orderedSteps(spine)
    .filter((s) => s.phase === phase)
    .every((s) => spine.steps.find((st) => st.id === s.id)?.status === "accepted")

const notifyPhaseAccepted = (userId: string, phase: string): void => {
  void notify(userId, {
    type: "phase_accepted",
    title: `Đã hoàn tất phase ${phase}`,
    body: `Mọi step của phase ${phase} đã được accept. Có thể tiếp tục sang phase kế tiếp.`,
    meta: { phase }
  })
}

/** F6/B7: `accept`/`accept_as_is` chỉ trên step đang chờ gate; `revision`/`regenerate` CÒN được phép trên
 *  step đã `accepted` (quay lại step cũ — reopen). */
const requireGateable = (state: StepState | undefined, stepId: string, action: GateActionKind): StepState => {
  const gateableNow = state?.status === "in_progress" || state?.status === "revision_requested"
  const reopenable = state?.status === "accepted" && (action === "revision" || action === "regenerate")
  if (!state || (!gateableNow && !reopenable)) {
    throw new ApiError(409, `Step ${stepId} không ở trạng thái chờ gate`, STEP_NOT_RUNNABLE)
  }
  return state
}

/** F14: id cờ mới = hậu tố số LỚN NHẤT hiện có + 1 — tránh trùng id sau khi cờ cũ bị cascade xoá
 *  (đếm `flags.length + 1` có thể trùng id còn sống nếu một flag ở giữa danh sách đã bị xoá). */
const nextFlagId = (spine: Spine): string => {
  const maxSuffix = spine.flags.reduce((max, f) => {
    const m = /^FL(\d+)$/.exec(f.id)
    return m ? Math.max(max, Number(m[1])) : max
  }, 0)
  return `FL${String(maxSuffix + 1).padStart(3, "0")}`
}

const assertVersion = (record: SpineRecord, baseVersion: number): void => {
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }
}

// ─── accept / accept_as_is ─────────────────────────────────────────

const doAccept = async (projectId: string, stepId: string, userId: string, record: SpineRecord, yellowFlagNote: string | null): Promise<number> => {
  const spine = stripRecord(record)
  const ops: Op[] = [
    { op: "set", path: `steps[id=${stepId}].status`, value: "accepted" },
    { op: "set", path: `steps[id=${stepId}].accepted_at`, value: new Date().toISOString() },
    ...signOffOps(stepId)
  ]

  if (yellowFlagNote !== null) {
    const nextId = nextFlagId(spine)
    const fed = sectionsFedBy(spine, stepId)
    const flag: Flag = {
      id: nextId,
      level: "yellow",
      rule_id: "accepted_as_is",
      section_id: fed[0] ?? "fixed:I",
      target_id: null,
      message: yellowFlagNote,
      remediation_step: stepId,
      opened_at_version: spine.spine_version + 1,
      resolved_at: null,
      waived_by_user: false,
      waive_reason: null,
      waived_at_version: null
    }
    ops.push({ op: "add", path: "flags[]", value: flag })
  }

  const applied = await applyTransaction(projectId, { base_version: record.spine_version, ops, by: userId, step_id: stepId, reason: yellowFlagNote ? "gate: accept_as_is" : "gate: accept" })

  const def = getStep(stepId)
  const afterSpine = stripRecord(applied.spine)
  if (phaseFullyAccepted(afterSpine, def.phase)) notifyPhaseAccepted(userId, def.phase)

  return applied.spine_version
}

// ─── revision / regenerate ──────────────────────────────────────────

interface SeqRange {
  startSeq: number
  existing: Pick<StepState, "first_seq" | "last_seq"> | undefined
}

/** Draft lại (revision/regenerate) + render/review; không stream (`emit` no-op — `/gate` không phải SSE).
 *  F3: cập nhật `first_seq/last_seq` theo dải change THẬT sự ghi trong lượt này (bug cũ: không cập nhật
 *  ⇒ regenerate lần 2 revert nhầm/không đủ nội dung của lần 1). */
const redraft = async (
  projectId: string,
  stepId: string,
  userId: string,
  callKind: "revision" | "regenerate",
  extra: { answers?: string; revisionRequest?: string },
  deps: StepRunnerDeps,
  range: SeqRange
): Promise<number> => {
  const spineNow = stripRecord(await load(projectId))
  const ctx = await buildStepContext(projectId, stepId)
  const noop = (): void => {}
  await runDraftPhase(projectId, stepId, ctx, spineNow, userId, callKind, noop, deps, extra)
  const afterVersion = await runRenderReviewPhase(projectId, stepId, getStep(stepId).renders, parseStepId(stepId).loop, userId, noop, deps)
  return trackSeqRange(projectId, afterVersion, stepId, userId, range.startSeq, range.existing)
}

// ─── điểm vào công khai ──────────────────────────────────────────────

export const gate = async (
  projectId: string,
  stepId: string,
  userId: string,
  input: GateInput,
  deps: Partial<StepRunnerDeps> = {}
): Promise<GateResult> => {
  acquireStepLock(projectId, stepId)
  try {
    const d: StepRunnerDeps = { ...defaultStepRunnerDeps(), ...deps }
    const record = await load(projectId)
    assertVersion(record, input.base_version)
    const spine = stripRecord(record)
    const state = requireGateable(
      spine.steps.find((s) => s.id === stepId),
      stepId,
      input.action
    )
    const reopening = state.status === "accepted"

    let finalVersion = record.spine_version

    if (input.action === "accept") {
      finalVersion = await doAccept(projectId, stepId, userId, record, null)
    } else if (input.action === "accept_as_is") {
      finalVersion = await doAccept(projectId, stepId, userId, record, input.note ?? "")
    } else {
      // revision | regenerate
      let baseVersion = record.spine_version
      let range: SeqRange

      if (reopening) {
        // B7 (F6): quay lại step đã accepted — vòng mới, reset first_seq/last_seq/accepted_at. Mốc vòng
        // mới (F1) = `at` của chính change `status=revision_requested` này (roundStartedAt tìm change
        // steps[id=X].status="in_progress" GẦN NHẤT — redraft ở dưới sẽ đưa status về "in_progress" nên
        // vòng mới bắt đầu tính đúng từ đây).
        const reopened = await applyTransaction(projectId, {
          base_version: baseVersion,
          ops: [
            { op: "set", path: `steps[id=${stepId}].status`, value: "revision_requested" },
            { op: "set", path: `steps[id=${stepId}].first_seq`, value: null },
            { op: "set", path: `steps[id=${stepId}].last_seq`, value: null },
            { op: "set", path: `steps[id=${stepId}].accepted_at`, value: null }
          ],
          by: userId,
          step_id: stepId,
          reason: "gate: reopen step đã accepted (B7)"
        })
        baseVersion = reopened.spine_version
        range = { startSeq: await spineRepository.nextSeq(projectId), existing: { first_seq: null, last_seq: null } }
      } else {
        const counts = await usageCounts(projectId, stepId, state.first_seq)
        if (counts.calls_used >= CALLS_LIMIT) {
          throw new GateLimitError(CALL_LIMIT, `Step ${stepId} đã dùng hết ${CALLS_LIMIT} lượt gọi model`, { calls_used: counts.calls_used })
        }
        if (input.action === "regenerate" && counts.regenerate_used >= REGENERATE_LIMIT_COUNT) {
          throw new GateLimitError(REGENERATE_LIMIT, `Step ${stepId} đã dùng hết ${REGENERATE_LIMIT_COUNT} lượt regenerate`, { regenerate_used: counts.regenerate_used })
        }

        if (input.action === "regenerate") {
          if (state.first_seq !== null && state.last_seq !== null) {
            await assertRangeOwnedByStep(projectId, stepId, state.first_seq, state.last_seq)
            const reverted = await revertRange(projectId, state.first_seq, state.last_seq, { by: userId, step_id: stepId, base_version: baseVersion })
            const resetRange = await applyTransaction(projectId, {
              base_version: reverted.spine_version,
              ops: [
                { op: "set", path: `steps[id=${stepId}].first_seq`, value: null },
                { op: "set", path: `steps[id=${stepId}].last_seq`, value: null }
              ],
              by: userId,
              step_id: stepId,
              reason: "gate: regenerate — reset dải seq"
            })
            baseVersion = resetRange.spine_version
            range = { startSeq: await spineRepository.nextSeq(projectId), existing: { first_seq: null, last_seq: null } }
          } else {
            range = { startSeq: await spineRepository.nextSeq(projectId), existing: state }
          }
        } else {
          // revision — giữ nguyên first_seq/last_seq hiện có, redraft chỉ MỞ RỘNG dải (không revert)
          const toRevision = await applyTransaction(projectId, {
            base_version: baseVersion,
            ops: [{ op: "set", path: `steps[id=${stepId}].status`, value: "revision_requested" }],
            by: userId,
            step_id: stepId,
            reason: "gate: revision requested"
          })
          baseVersion = toRevision.spine_version
          range = { startSeq: await spineRepository.nextSeq(projectId), existing: state }
        }
      }

      if (input.action === "regenerate") {
        const functionScope = input.function_id ? { revisionRequest: `Regenerate scope: chỉ function ${input.function_id}.` } : {}
        finalVersion = await redraft(projectId, stepId, userId, "regenerate", functionScope, d, range)
      } else {
        finalVersion = await redraft(projectId, stepId, userId, "revision", { revisionRequest: input.note ?? "" }, d, range)
        const backToProgress = await applyTransaction(projectId, {
          base_version: finalVersion,
          ops: [{ op: "set", path: `steps[id=${stepId}].status`, value: "in_progress" }],
          by: userId,
          step_id: stepId,
          reason: "gate: revision applied"
        })
        finalVersion = backToProgress.spine_version
      }
    }

    const afterRecord = await load(projectId)
    const afterSpine = stripRecord(afterRecord)
    const afterFirstSeq = afterSpine.steps.find((s) => s.id === stepId)?.first_seq ?? null
    const afterCounts = await usageCounts(projectId, stepId, afterFirstSeq)
    const summary = buildSummary(afterSpine, stepId, afterCounts)
    const next = nextStepOf(afterSpine)

    return { step: summary, next_step: next?.id ?? null, spine_version: finalVersion }
  } finally {
    releaseStepLock(projectId, stepId)
  }
}
