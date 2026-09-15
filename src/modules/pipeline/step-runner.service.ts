/**
 * step-runner.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Khung hành động dùng chung cho 12 phase (Phases §3, `assets/skills/action/srs-orchestrator/SKILL.md`):
 * Intake → Elicit → Draft → Render → Review → Gate (khung "sẵn sàng gate", hành động gate ở `gate.service`)
 * → Meter mỗi lượt gọi model.
 *
 * `runStep` là điểm vào công khai cho HTTP (SSE, `pipeline.controller.ts`) VÀ cho T14 gọi trực tiếp
 * (không qua HTTP) — tham số `deps` cắm mock provider trong test, không cần mock module.
 *
 * Lỗi: guard-clause (session không pipeline, step không tồn tại/không tới lượt, base_version lệch,
 * CALL_LIMIT đã đầy trước khi chạy) NÉM lỗi trước khi gọi `emit` lần nào — bên gọi HTTP (controller) coi
 * đây là lỗi JSON thường (403/404/409). Lỗi giữa chừng (draft hỏng, ghi Spine xung đột…) cũng ném —
 * controller phát nó thành sự kiện SSE `error` vì lúc đó header đã gửi (xem `pipeline.controller.ts`).
 */

import { randomUUID } from "node:crypto"
import { ChatSession, type IChatMessage } from "../project/chat-session.model.js"
import * as spineRepository from "../spine/spine.repository.js"
import { applyTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import type { Spine, SpineRecord, StepState } from "../spine/spine.types.js"
import * as flagsService from "../spine/flags.service.js"
import { renderDiagrams, type DiagramServiceDeps } from "../diagram/diagram.service.js"
import type { RenderTarget } from "../diagram/renderers/index.js"
import { getStep, nextStep as nextStepOf } from "./step-registry.js"
import { buildStepContext, getStepSpec, parseStepId, type StepContext } from "./context-projection.js"
import { draftOps, type DraftCallKind, type DraftExecutor } from "./draft-to-ops.js"
import * as meter from "./meter.service.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import type { ElicitOutput, OpTransaction, ReviewOutput } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { PIPELINE_ERROR_STATUS, gateActionSchema, type PipelineErrorCode, type StepEvent } from "./pipeline.dto.js"
import type { z } from "zod"

type GateAction = z.infer<typeof gateActionSchema>

export const NOT_PIPELINE_SESSION = "NOT_PIPELINE_SESSION"
export const STEP_NOT_RUNNABLE = "STEP_NOT_RUNNABLE"
export const CALL_LIMIT = "CALL_LIMIT"
export const CALLS_LIMIT = 8
export const REGENERATE_LIMIT_COUNT = 3

export type Emit = (event: StepEvent) => void

// ─── dependency injection (mock provider trong test / T14) ───────

export type ElicitExecutor = (input: AiActionInput, projectId: string, userId: string) => Promise<AiActionResult<ElicitOutput>>
export type ReviewExecutor = (input: AiActionInput, projectId: string, userId: string) => Promise<AiActionResult<ReviewOutput>>

export interface StepRunnerDeps {
  /** Draft/Regenerate/Revision — mặc định gọi `executeAiAction` (T04 reserve/deduct/release credit thật ở ví). */
  draftExecutor: DraftExecutor
  elicitExecutor: ElicitExecutor
  /** Chỉ dùng khi `process.env.REVIEW_LLM_ENABLED === "true"` (mặc định tắt). */
  reviewExecutor: ReviewExecutor
  renderDeps?: Partial<DiagramServiceDeps>
}

export const defaultStepRunnerDeps = (): StepRunnerDeps => ({
  draftExecutor: (actionType, input, projectId, userId) => executeAiAction<OpTransaction>(actionType, input, projectId, userId),
  elicitExecutor: (input, projectId, userId) => executeAiAction<ElicitOutput>(ActionType.ELICIT, input, projectId, userId),
  reviewExecutor: (input, projectId, userId) => executeAiAction<ReviewOutput>(ActionType.REVIEW, input, projectId, userId)
})

// ─── chờ trả lời Elicit (answer_needed) trong cùng luồng SSE ──────

export interface AnswerInput {
  question_id: string
  answer: string | string[]
}

interface PendingAnswer {
  resolve: (answers: AnswerInput[]) => void
  timeout: ReturnType<typeof setTimeout>
}

/** 15 phút — đủ để đọc câu hỏi và trả lời; không giữ promise treo vô hạn nếu người dùng bỏ đi. */
export const ANSWER_WAIT_TIMEOUT_MS = 15 * 60 * 1000

const pendingAnswers = new Map<string, PendingAnswer>()

const answerKey = (projectId: string, stepId: string, sessionId: string): string => `${projectId}::${stepId}::${sessionId}`

/** `POST /answer` gọi hàm này. `false` ⇒ không có lượt chờ khớp (step không ở `answer_needed`). */
export const submitAnswer = (projectId: string, stepId: string, sessionId: string, answers: AnswerInput[]): boolean => {
  const key = answerKey(projectId, stepId, sessionId)
  const pending = pendingAnswers.get(key)
  if (!pending) return false
  clearTimeout(pending.timeout)
  pendingAnswers.delete(key)
  pending.resolve(answers)
  return true
}

const waitForAnswer = (projectId: string, stepId: string, sessionId: string): Promise<AnswerInput[]> => {
  const key = answerKey(projectId, stepId, sessionId)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAnswers.delete(key)
      reject(new ApiError(409, `Hết thời gian chờ trả lời câu hỏi của step ${stepId}`, STEP_NOT_RUNNABLE))
    }, ANSWER_WAIT_TIMEOUT_MS)
    pendingAnswers.set(key, { resolve, timeout })
  })
}

// ─── helper ────────────────────────────────────────────────────────

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

const refresh = async (projectId: string): Promise<{ spine: Spine; spineVersion: number }> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  return { spine: stripRecord(record), spineVersion: record.spine_version }
}

const pushTranscript = async (sessionId: string, stepId: string, role: "user" | "ai", content: string): Promise<void> => {
  const msg: IChatMessage = { role, content, step: stepId, createdAt: new Date() }
  await ChatSession.updateOne({ _id: sessionId }, { $push: { messages: msg } })
}

/** `calls_used`/`regenerate_used` của vòng hiện tại của step. */
const usageCounts = meter.roundCounts

// ─── Draft + ghi Spine (dùng chung cho /run và gate regenerate/revision) ──

export interface DraftPhaseResult {
  spineVersion: number
  applied: boolean
}

/**
 * Chạy một lượt Draft (draft-to-ops T11) và ghi Spine (op engine T08). 409 SPINE_VERSION_CONFLICT ⇒ hoàn
 * usage[] của lượt này (không tiêu trần) rồi ném lại. `emit` có thể là no-op (gate.service không stream).
 */
export const runDraftPhase = async (
  projectId: string,
  stepId: string,
  ctx: StepContext,
  spine: Spine,
  userId: string,
  callKind: DraftCallKind,
  emit: Emit,
  deps: StepRunnerDeps,
  extra: { answers?: string; revisionRequest?: string } = {}
): Promise<DraftPhaseResult> => {
  const draftResult = await draftOps(projectId, stepId, ctx, { userId, executor: deps.draftExecutor, spine, callKind, ...extra })

  const usageIds = await meter.recordUsage(
    projectId,
    userId,
    stepId,
    draftResult.usage.map((u) => ({
      call_kind: u.call_kind,
      attempt: u.attempt,
      tokens_in: u.tokens_in,
      tokens_out: u.tokens_out,
      cost: u.cost,
      logId: u.logId
    }))
  )

  for (const attempt of draftResult.attempts) emit({ type: "draft", step_id: stepId, attempt: attempt.attempt })

  if (!draftResult.txn) return { spineVersion: spine.spine_version, applied: false }

  try {
    const applied = await applyTransaction(projectId, draftResult.txn)
    emit({
      type: "ops_applied",
      step_id: stepId,
      txn: applied.txn ?? randomUUID(),
      spine_version: applied.spine_version,
      changes: applied.changes.map((c) => ({ op: c.op, path: c.path, before: c.before, value: c.value, reason: c.reason }))
    })
    return { spineVersion: applied.spine_version, applied: true }
  } catch (err) {
    if (err instanceof ApiError && err.code === spineRepository.SPINE_VERSION_CONFLICT) {
      // 409 hai tab: model đã trả lời (credit đã deduct ở ví) nhưng Spine không ghi được — hoàn usage[],
      // không tính vào trần. Số dư VÍ thật: xem TODO(XREQ-local-1) trong meter.service.ts.
      await meter.refundUsage(usageIds)
    }
    throw err
  }
}

/** Render mọi diagram của step (nếu có) + Review (deterministic check; LLM review tuỳ `REVIEW_LLM_ENABLED`). */
export const runRenderReviewPhase = async (
  projectId: string,
  stepId: string,
  renders: readonly RenderTarget["kind"][],
  loop: string | null,
  userId: string,
  emit: Emit,
  deps: StepRunnerDeps
): Promise<number> => {
  let spineVersion = (await refresh(projectId)).spineVersion

  if (renders.length > 0) {
    const targets: RenderTarget[] = renders.map((kind) => ({ kind, owner_id: kind === "screen_layout" ? loop : null }))
    const result = await renderDiagrams(projectId, targets, {
      by: userId,
      step_id: stepId,
      ...(deps.renderDeps ? { deps: deps.renderDeps } : {})
    })
    spineVersion = result.spine_version
    for (const id of result.rendered) {
      const diagram = result.diagrams.find((d) => d.id === id)
      emit({
        type: "render",
        step_id: stepId,
        diagram_id: id,
        render_status: diagram?.render_status ?? "error",
        ...(diagram?.error ? { error: diagram.error } : {})
      })
    }
  }

  const flagsResult = await flagsService.recompute(projectId, { by: userId })
  spineVersion = flagsResult.checked_at_version
  const redOpen = flagsResult.flags.filter((f) => f.level === "red" && f.resolved_at === null).length
  const yellowOpen = flagsResult.flags.filter((f) => f.level === "yellow" && f.resolved_at === null).length
  emit({ type: "flags", step_id: stepId, red_open: redOpen, yellow_open: yellowOpen })

  // Lớp phủ LLM review — tắt mặc định (đọc process.env trực tiếp, không qua src/config theo yêu cầu task).
  if (process.env.REVIEW_LLM_ENABLED === "true") {
    try {
      const { spine } = await refresh(projectId)
      const spec = getStepSpec(stepId)
      const result = await deps.reviewExecutor(
        { promptVariables: { step_id: stepId, step_name: spec.label_en, working_mode: spine.project.working_mode ?? "coaching" } },
        projectId,
        userId
      )
      await meter.recordUsage(projectId, userId, stepId, [
        {
          call_kind: "review",
          attempt: 1,
          tokens_in: result.tokensUsed.promptTokens,
          tokens_out: result.tokensUsed.completionTokens,
          cost: result.cost,
          logId: result.logId || null
        }
      ])
    } catch (err) {
      // Review LLM là lớp phủ thêm, không chặn step — lỗi chỉ log.
      console.error(`[step-runner] LLM review thất bại cho ${stepId}:`, err)
    }
  }

  return spineVersion
}

/** Ghi lại `steps[id].first_seq/last_seq` theo dải change thực tế đã ghi kể từ `startSeq`. */
const trackSeqRange = async (
  projectId: string,
  spineVersion: number,
  stepId: string,
  userId: string,
  startSeq: number,
  existing: Pick<StepState, "first_seq" | "last_seq"> | undefined
): Promise<number> => {
  const changes = (await spineRepository.listChanges(projectId, { fromSeq: startSeq })).filter((c) => c.step_id === stepId)
  if (changes.length === 0) return spineVersion

  const minSeq = Math.min(...changes.map((c) => c.seq))
  const maxSeq = Math.max(...changes.map((c) => c.seq))
  const firstSeq = existing?.first_seq ?? minSeq
  const lastSeq = existing?.last_seq !== null && existing?.last_seq !== undefined ? Math.max(existing.last_seq, maxSeq) : maxSeq
  if (firstSeq === existing?.first_seq && lastSeq === existing?.last_seq) return spineVersion

  const ops: Op[] = [
    { op: "set", path: `steps[id=${stepId}].first_seq`, value: firstSeq },
    { op: "set", path: `steps[id=${stepId}].last_seq`, value: lastSeq }
  ]
  const result = await applyTransaction(projectId, { base_version: spineVersion, ops, by: userId, step_id: stepId, reason: "step-runner: cập nhật dải seq" })
  return result.spine_version
}

// ─── guard clauses ─────────────────────────────────────────────────

const requirePipelineSession = async (projectId: string, sessionId: string): Promise<void> => {
  const session = await ChatSession.findById(sessionId)
  if (!session || String(session.projectId) !== String(projectId)) {
    throw new ApiError(404, "Không tìm thấy chat session", "SPINE_NOT_FOUND")
  }
  if (!session.is_pipeline) {
    throw new ApiError(403, "Session này không phải session pipeline — chỉ dùng để hỏi đáp (CHAT)", NOT_PIPELINE_SESSION)
  }
}

// ─── điểm vào công khai ─────────────────────────────────────────────

/**
 * Chạy một step trọn vẹn: Intake → Elicit → Draft → Render → Review → phát `gate_ready`.
 *
 * `deps` tuỳ chọn — mặc định gọi model thật qua `executeAiAction` (T04 lo reserve/deduct/release credit ở
 * ví). Test/T14 truyền `deps.draftExecutor`/`deps.elicitExecutor` để cắm provider giả lập mà không cần
 * HTTP hay mock module — đây là "cách chạy step không cần HTTP" công khai cho T14/T16.
 */
export const runStep = async (
  projectId: string,
  stepId: string,
  sessionId: string,
  userId: string,
  emit: Emit,
  deps: Partial<StepRunnerDeps> = {}
): Promise<void> => {
  const d: StepRunnerDeps = { ...defaultStepRunnerDeps(), ...deps }

  await requirePipelineSession(projectId, sessionId)
  const stepDef = getStep(stepId) // 404 STEP_NOT_FOUND nếu id sai
  const spec = getStepSpec(stepId)
  const needsDraft = spec.skill !== null && !stepDef.deterministic

  let { spine, spineVersion } = await refresh(projectId)
  const existingStep = spine.steps.find((s) => s.id === stepId)

  if (existingStep?.status === "accepted") {
    throw new ApiError(409, `Step ${stepId} đã accepted — cần gate revision trước khi chạy lại`, STEP_NOT_RUNNABLE)
  }
  if (!existingStep) {
    const next = nextStepOf(spine)
    if (!next || next.id !== stepId) throw new ApiError(409, `Step ${stepId} chưa tới lượt chạy`, STEP_NOT_RUNNABLE)
  }

  if (needsDraft) {
    const { calls_used } = await usageCounts(projectId, stepId, existingStep)
    if (calls_used >= CALLS_LIMIT) throw new ApiError(409, `Step ${stepId} đã dùng hết ${CALLS_LIMIT} lượt gọi model`, CALL_LIMIT)
  }

  // ─── init: cập nhật progress cursor + đặt step in_progress (B7: reset vòng khi reopen sau accepted) ──
  const phaseChanged = spine.progress.current_phase !== stepDef.phase
  const reopenedAfterAccept = existingStep?.status === "revision_requested" && existingStep.accepted_at !== null

  const initOps: Op[] = []
  if (phaseChanged) initOps.push({ op: "set", path: "progress.current_phase", value: stepDef.phase }, { op: "set", path: "progress.elicit_turns_this_phase", value: 0 })
  if (spine.progress.current_step !== stepId) initOps.push({ op: "set", path: "progress.current_step", value: stepId })

  if (!existingStep) {
    initOps.push({ op: "add", path: "steps[]", value: { id: stepId, status: "in_progress", first_seq: null, last_seq: null, accepted_at: null } })
  } else if (existingStep.status !== "in_progress") {
    initOps.push({ op: "set", path: `steps[id=${stepId}].status`, value: "in_progress" })
    if (reopenedAfterAccept) {
      initOps.push(
        { op: "set", path: `steps[id=${stepId}].first_seq`, value: null },
        { op: "set", path: `steps[id=${stepId}].last_seq`, value: null },
        { op: "set", path: `steps[id=${stepId}].accepted_at`, value: null }
      )
    }
  }

  if (initOps.length > 0) {
    const applied = await applyTransaction(projectId, { base_version: spineVersion, ops: initOps, by: userId, step_id: stepId, reason: "step-runner: init step" })
    spineVersion = applied.spine_version
  }
  // startSeq CHỈ tính từ sau init ops: seq đánh dấu status=in_progress không phải nội dung của step, không
  // thuộc dải first_seq/last_seq — nếu không, resume revert dải sẽ xoá luôn phần tử `steps[]` (revert của
  // "add") rồi việc set lại status=pending bên dưới sẽ path_not_resolved.
  const startSeq = await spineRepository.nextSeq(projectId)
  ;({ spine, spineVersion } = await refresh(projectId))
  const stepStateForRound: Pick<StepState, "first_seq" | "last_seq"> | undefined = reopenedAfterAccept ? { first_seq: null, last_seq: null } : existingStep

  const ctx = await buildStepContext(projectId, stepId, { sessionId })
  if (phaseChanged) emit({ type: "intake", step_id: stepId, phase: stepDef.phase, empty_fields: ctx.emptyFields })

  let answersText = ctx.transcriptTail

  if (needsDraft) {
    const workingMode = spine.project.working_mode ?? "coaching"
    const shouldElicit = workingMode === "coaching" || spine.progress.elicit_turns_this_phase < 2

    if (shouldElicit) {
      const elicitResult = await d.elicitExecutor(
        {
          promptVariables: {
            step_id: stepId,
            step_name: ctx.label_en,
            working_mode: workingMode,
            elicit_turns_this_phase: spine.progress.elicit_turns_this_phase,
            missing: ctx.emptyFields,
            projection: ctx.projection,
            addendum: ctx.addendum,
            content_guidance: "",
            recent_turns: ctx.transcriptTail,
            user_message: "(tự động — vòng elicit đầu step)"
          }
        },
        projectId,
        userId
      )
      await meter.recordUsage(projectId, userId, stepId, [
        {
          call_kind: "elicit",
          attempt: 1,
          tokens_in: elicitResult.tokensUsed.promptTokens,
          tokens_out: elicitResult.tokensUsed.completionTokens,
          cost: elicitResult.cost,
          logId: elicitResult.logId || null
        }
      ])
      emit({ type: "elicit", step_id: stepId, delta: elicitResult.data.reply })
      await pushTranscript(sessionId, stepId, "ai", elicitResult.data.reply)

      const turnsApplied = await applyTransaction(projectId, {
        base_version: spineVersion,
        ops: [{ op: "set", path: "progress.elicit_turns_this_phase", value: spine.progress.elicit_turns_this_phase + 1 }],
        by: userId,
        step_id: stepId,
        reason: "step-runner: elicit turn"
      })
      spineVersion = turnsApplied.spine_version

      if (elicitResult.data.questions.length > 0) {
        const questions = elicitResult.data.questions.map((q, i) => ({
          id: `Q${i + 1}`,
          text: q.question,
          ...(q.suggestedAnswers.length > 0 ? { options: q.suggestedAnswers } : {}),
          ...(q.multiple !== undefined ? { multiple: q.multiple } : {})
        }))
        emit({ type: "answer_needed", step_id: stepId, questions })
        const answers = await waitForAnswer(projectId, stepId, sessionId)
        const answersJoined = answers.map((a) => `${a.question_id}: ${Array.isArray(a.answer) ? a.answer.join(", ") : a.answer}`).join("\n")
        for (const a of answers) await pushTranscript(sessionId, stepId, "user", Array.isArray(a.answer) ? a.answer.join(", ") : a.answer)
        answersText = `${answersText}\n${answersJoined}`.trim()
      }
      ;({ spine, spineVersion } = await refresh(projectId))
    }

    const draftPhase = await runDraftPhase(projectId, stepId, ctx, spine, userId, "draft", emit, d, { answers: answersText })
    spineVersion = draftPhase.spineVersion
  }

  spineVersion = await runRenderReviewPhase(projectId, stepId, stepDef.renders, parseStepId(stepId).loop, userId, emit, d)
  spineVersion = await trackSeqRange(projectId, spineVersion, stepId, userId, startSeq, stepStateForRound)
  void spineVersion

  const { spine: finalSpine } = await refresh(projectId)
  const finalStep = finalSpine.steps.find((s) => s.id === stepId)
  const { calls_used, regenerate_used } = await usageCounts(projectId, stepId, finalStep)
  const actions: GateAction[] = regenerate_used >= REGENERATE_LIMIT_COUNT ? ["accept", "revision", "accept_as_is"] : ["accept", "revision", "regenerate"]

  emit({ type: "gate_ready", step_id: stepId, actions, regenerate_used, calls_used })
}

/** Mã lỗi pipeline hợp lệ — controller dùng để quyết định phát SSE `error` hay để nguyên lỗi HTTP thường. */
export const isPipelineErrorCode = (code: string): code is PipelineErrorCode => code in PIPELINE_ERROR_STATUS
