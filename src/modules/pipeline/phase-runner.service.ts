/**
 * phase-runner.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Chạy liền các bước của một giai đoạn trên MỘT luồng SSE — `02-reduce-stops-plan.md` R2 (FLF-208).
 *
 * Trước đây mỗi bước là một lần bấm Chạy rồi một lần bấm Accept: 91 điểm dừng cho một dự án 7 màn, phần
 * lớn là những bước không hỏi gì và không ghi gì. Ở đây một lời gọi chạy hết giai đoạn:
 *
 *   - bước **yên lặng** (`quiet-step.ts`) được tự Accept, phát `auto_accepted`, rồi chạy tiếp;
 *   - chuỗi **dừng sớm** khi có câu hỏi, có cờ đỏ mới, có lỗi, hoặc tới bước luôn cần người quyết;
 *   - bước cuối giai đoạn KHÔNG tự Accept: nó là cổng chốt mang **tóm tắt của cả giai đoạn**
 *     (`phase_gate`), để user duyệt một lần với đủ nội dung thay vì duyệt mười lần với mười con số.
 *
 * Vòng S-5 tính theo **màn**, không theo cả pha: "giai đoạn" của `S-5.2@S03` là năm bước của màn S03, nên
 * cổng chốt rơi đúng vào S-5.5 của màn đó (Phases §6.2).
 */

import { runStep, defaultStepRunnerDeps, type Emit, type StepRunnerDeps } from "./step-runner.service.js"
import { ChatSession, type IChatMessage } from "../project/chat-session.model.js"
import { projectStep } from "./context-projection.js"
import { decisionOps, filterAskedQuestions, ledgerForPrompt } from "./decisions.service.js"
import { MAX_QUESTIONS_PER_TURN, answerText, answeredTopics, shapeQuestions } from "./question-shape.js"
import { submitAnswerWait } from "./step-runner.service.js"
import * as meter from "./meter.service.js"
import { applyTransaction } from "../spine/op-engine.js"
import { gate } from "./gate.service.js"
import { getStep, nextStep as nextStepOf, orderedSteps, type ExpandedStep } from "./step-registry.js"
import { isQuietStep, type QuietVerdict } from "./quiet-step.js"
import * as spineRepository from "./../spine/spine.repository.js"
import type { Spine, SpineRecord } from "../spine/spine.types.js"
import type { ChangeSummary, StepEvent } from "./pipeline.dto.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { AnswerDetached } from "./step-runner.errors.js"
import { acquireRun, detachRun, finishRun, registerAbort, touchRun, type PendingAnswerState } from "./run-state.service.js"
import type { AnswerInput } from "./step-runner.service.js"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

/** Trần số bước chạy liền trong một lời gọi — chặn vòng lặp vô hạn nếu `nextStep` không tiến. */
export const MAX_PHASE_STEPS = 30

/**
 * "Đơn vị giai đoạn" của một bước: phase thường là chính nó; vòng S-5 là từng màn. Hai bước cùng đơn vị
 * thì chạy liền nhau trong một lời gọi.
 */
export const phaseUnitOf = (step: ExpandedStep): string => (step.loop === null ? step.phase : `${step.phase}@${step.loop}`)

/** Bước cuối của đơn vị giai đoạn — nơi đặt cổng chốt gộp. */
export const isPhaseTerminal = (spine: Spine, step: ExpandedStep): boolean => {
  const unit = phaseUnitOf(step)
  const steps = orderedSteps(spine).filter((s) => phaseUnitOf(s) === unit)
  return steps.length > 0 && steps[steps.length - 1].id === step.id
}

/**
 * Ghi hỏi/đáp của lượt phỏng vấn đầu giai đoạn: transcript (user thấy lại trong khung chat, các bước trong giai
 * đoạn đọc nó như câu trả lời của chính mình) + sổ quyết định. Dùng chung cho lượt đang nghe và cho `/answer`
 * khi lượt chờ đã tách khỏi kết nối (FLF-222).
 */
const recordInterviewAnswers = async (
  projectId: string,
  unit: string,
  sessionId: string,
  userId: string,
  reply: string,
  asked: PendingAnswerState["asked"],
  answers: readonly AnswerInput[]
): Promise<void> => {
  const transcript: IChatMessage[] = [
    { role: "ai", content: [reply, ...asked.map((q, i) => `${i + 1}. ${q.question}`)].join("\n"), step: unit, createdAt: new Date() },
    ...answers.map((a) => ({
      role: "user" as const,
      content: answerText(a.answer),
      step: unit,
      createdAt: new Date()
    }))
  ]
  await ChatSession.updateOne({ _id: sessionId }, { $push: { messages: { $each: transcript } } })

  const { record, spine: spineNow } = await load(projectId)
  const ops = decisionOps(spineNow, unit, answeredTopics(asked, answers))
  if (ops.length > 0) {
    await applyTransaction(projectId, { base_version: record.spine_version, ops, by: userId, step_id: null, reason: `Phỏng vấn đầu giai đoạn ${unit}` })
  }
}

/**
 * `/answer` cho lượt phỏng vấn đầu giai đoạn đã tách khỏi kết nối: ghi câu trả lời rồi đóng lượt (`done`).
 * Không tự chạy cả giai đoạn ở nền — FE chạy lại giai đoạn, phỏng vấn tự bỏ vì chủ đề đã chốt.
 */
export const resumePhaseInterview = async (
  projectId: string,
  unit: string,
  userId: string,
  pending: PendingAnswerState,
  answers: readonly AnswerInput[]
): Promise<void> => {
  // Chiếm khoá để hai `/answer` cùng lúc không ghi hai lần (lượt sau 409)
  const run = await acquireRun(projectId, unit, { sessionId: pending.session_id, by: userId, stage: "ask", detail_vi: `Đã nhận ${answers.length} câu trả lời` })
  try {
    await recordInterviewAnswers(projectId, unit, pending.session_id, userId, pending.reply ?? "", pending.asked, answers)
    await finishRun(projectId, unit, run.run_id, "done", { questions: null })
  } catch (err) {
    await finishRun(projectId, unit, run.run_id, "interrupted", { error: { code: err instanceof ApiError ? err.code : "UNKNOWN", message: err instanceof Error ? err.message : String(err) } })
    throw err
  }
}

/** Kết quả lượt phỏng vấn: không hỏi, đã có câu trả lời, hoặc lượt chờ tách khỏi kết nối. */
type InterviewOutcome = "skipped" | "answered" | "detached"

/**
 * Hỏi gộp đầu giai đoạn (R3): một lượt elicit nhận hợp `empty_fields` của MỌI bước trong giai đoạn cùng
 * sổ quyết định, trả tối đa `MAX_QUESTIONS_PER_TURN` câu (FLF-220 — cùng trần với mọi lượt hỏi). Chạy ở
 * mọi chế độ duyệt.
 *
 * Lượt chờ ghi ở run-state của đơn vị giai đoạn (`step_runs` với `step_id` = `unit`) để reload dựng lại thẻ hỏi
 * và `/answer` ghi được câu trả lời kể cả khi kết nối đã đóng (FLF-222).
 *
 * Không hỏi lại điều đã chốt (sổ quyết định lọc trước), và câu trả lời ghi thẳng vào sổ nên mọi bước sau
 * đều dùng được — kể cả khi user rời máy giữa chừng rồi quay lại. Điều còn thiếu thì step bên trong tự hỏi.
 */
const runPhaseInterview = async (
  projectId: string,
  unit: string,
  sessionId: string,
  userId: string,
  emit: Emit,
  deps: StepRunnerDeps
): Promise<InterviewOutcome> => {
  const { spine } = await load(projectId)
  // Chuỗi dừng giữa chừng rồi chạy tiếp là chuyện thường (user duyệt một cổng chốt). Không nhớ đã phỏng
  // vấn giai đoạn này thì lần chạy tiếp lại hỏi lại từ đầu — mất credit và hỏi đúng thứ user vừa trả lời.
  if (spine.decisions.some((d) => d.step_id === unit && d.superseded_by === null)) return "skipped"
  // Câu trả lời mở gõ gộp một đoạn không vào sổ quyết định (FLF-220) ⇒ sổ không đủ làm dấu "đã phỏng vấn".
  // Transcript của lượt phỏng vấn (lưu với `step` = đơn vị giai đoạn) thì luôn có.
  const session = await ChatSession.findById(sessionId, { messages: 1 }).lean()
  if ((session?.messages ?? []).some((m) => m.step === unit)) return "skipped"
  const steps = orderedSteps(spine).filter((s) => phaseUnitOf(s) === unit)
  const missing = [...new Set(steps.flatMap((step) => {
    try {
      return projectStep(spine, step.id).emptyFields
    } catch {
      return []
    }
  }))]
  if (missing.length === 0) return "skipped"

  const run = await acquireRun(projectId, unit, { sessionId, by: userId, stage: "ask", detail_vi: "Xem giai đoạn này còn thiếu gì để hỏi bạn" })
  if (deps.abort) registerAbort(run.run_id, deps.abort)
  let outcome: InterviewOutcome | null = null
  try {
    outcome = await askPhaseInterview(projectId, unit, sessionId, userId, emit, deps, spine, missing, run.run_id)
    return outcome
  } finally {
    if (outcome === "detached") await detachRun(projectId, unit, run.run_id)
    else await finishRun(projectId, unit, run.run_id, outcome === null ? "interrupted" : "done", { questions: null })
  }
}

const askPhaseInterview = async (
  projectId: string,
  unit: string,
  sessionId: string,
  userId: string,
  emit: Emit,
  deps: StepRunnerDeps,
  spine: Spine,
  missing: string[],
  runId: string
): Promise<InterviewOutcome> => {
  const reservedId = await meter.reserveCall(projectId, userId, unit, "elicit")
  let result
  try {
    result = await deps.elicitExecutor(
      {
        promptVariables: {
          step_id: unit,
          step_name: `Phỏng vấn đầu giai đoạn ${unit}`,
          phase_interview: true,
          max_questions: MAX_QUESTIONS_PER_TURN,
          missing,
          projection: {},
          addendum: [],
          content_guidance: "",
          decisions: ledgerForPrompt(spine),
          recent_turns: "",
          user_message: "(tự động — hỏi gộp đầu giai đoạn)"
        }
      },
      projectId,
      userId
    )
  } catch (err) {
    await meter.releaseCall(reservedId)
    throw err
  }
  await meter.finalizeCall(reservedId, {
    call_kind: "elicit",
    attempt: 1,
    tokens_in: result.tokensUsed.promptTokens,
    tokens_out: result.tokensUsed.completionTokens,
    cost: result.cost,
    logId: result.logId || null
  })

  const { asked, questions } = shapeQuestions(filterAskedQuestions(spine, result.data.questions).questions)
  if (asked.length === 0) return "skipped"

  emit({ type: "elicit", step_id: unit, delta: result.data.reply })
  const answerNeeded: StepEvent = { type: "answer_needed", step_id: unit, questions }
  emit(answerNeeded)
  await touchRun(projectId, unit, runId, {
    status: "waiting_answer",
    stage: "ask",
    detail_vi: `Chờ bạn trả lời ${questions.length} câu`,
    questions,
    pending_answer: { kind: "phase_interview", unit, session_id: sessionId, asked, base_answers_text: "", reply: result.data.reply },
    release: true,
    appendEvent: answerNeeded
  })

  let answers: AnswerInput[]
  try {
    answers = await submitAnswerWait(projectId, unit, sessionId, deps.signal)
  } catch (err) {
    if (err instanceof AnswerDetached) return "detached"
    throw err
  }
  emit({ type: "answer_received", step_id: unit, count: answers.length })
  await recordInterviewAnswers(projectId, unit, sessionId, userId, result.data.reply, asked, answers)
  return "answered"
}

export interface PhaseStepOutcome {
  step_id: string
  label_vi: string
  auto_accepted: boolean
  reason_vi: string
  summary: ChangeSummary[]
}

export interface PhaseRunResult {
  phase: string
  /** Bước đang chờ user (gate hoặc câu hỏi); null ⇒ đã chạy hết giai đoạn. */
  stopped_at: string | null
  reason_vi: string
  steps: PhaseStepOutcome[]
}

interface StepSignals {
  asked: boolean
  gate: Extract<StepEvent, { type: "gate_ready" }> | null
  error: Extract<StepEvent, { type: "error" }> | null
  renderFailed: boolean
}

const collectSignals = (emit: Emit): { emit: Emit; signals: StepSignals } => {
  const signals: StepSignals = { asked: false, gate: null, error: null, renderFailed: false }
  return {
    signals,
    emit: (event) => {
      if (event.type === "answer_needed") signals.asked = true
      if (event.type === "gate_ready") signals.gate = event
      if (event.type === "error") signals.error = event
      if (event.type === "render" && event.render_status === "error") signals.renderFailed = true
      emit(event)
    }
  }
}

const load = async (projectId: string): Promise<{ record: SpineRecord; spine: Spine }> => {
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  return { record, spine: stripRecord(record) }
}

/**
 * Chạy hết một giai đoạn. `phase` là id phase (`S-6`) hoặc đơn vị vòng S-5 (`S-5@S03`); truyền phase của
 * bước tới lượt là đủ. Mọi sự kiện của từng bước vẫn phát nguyên vẹn — FE cũ hiển thị được như thường.
 */
export const runPhase = async (
  projectId: string,
  phase: string,
  sessionId: string,
  userId: string,
  emit: Emit,
  deps: Partial<StepRunnerDeps> = {}
): Promise<PhaseRunResult> => {
  const { spine: startSpine } = await load(projectId)
  const first = nextStepOf(startSpine)
  if (!first) return { phase, stopped_at: null, reason_vi: "Đã đi hết quy trình", steps: [] }

  const unit = phase.includes("@") || phase === first.phase ? phaseUnitOf(first) : phase
  // Giai đoạn không còn bước nào tới lượt (FE gọi lại sau khi duyệt bước cuối): về ngay, đừng phỏng vấn
  // đầu giai đoạn — một lượt gọi model tốn credit cho một giai đoạn đã đóng.
  if (phaseUnitOf(first) !== unit) return { phase: unit, stopped_at: null, reason_vi: "Đã xong giai đoạn này", steps: [] }
  const totalSteps = orderedSteps(startSpine).filter((s) => phaseUnitOf(s) === unit).length
  const d: StepRunnerDeps = { ...defaultStepRunnerDeps(deps.signal), ...deps }
  const outcomes: PhaseStepOutcome[] = []
  const phaseSummary: ChangeSummary[] = []
  const newAssumptions: { id: string; text: string }[] = []
  let flagsAtStart: { red: number; yellow: number } | null = null

  // R3 + FLF-220: hỏi gộp đầu giai đoạn ở mọi chế độ duyệt. Các bước bên trong vẫn hỏi được khi còn field
  // trống — sổ quyết định chặn lặp lại chủ đề vừa trả lời ở đây.
  const interview = await runPhaseInterview(projectId, unit, sessionId, userId, emit, d)
  // Kết nối đóng trong lúc chờ trả lời phỏng vấn: dừng chuỗi, câu hỏi nằm ở run-state của giai đoạn (FLF-222)
  if (interview === "detached") return { phase: unit, stopped_at: unit, reason_vi: "Chờ bạn trả lời câu hỏi đầu giai đoạn", steps: [] }

  for (let index = 0; index < MAX_PHASE_STEPS; index++) {
    const { record, spine } = await load(projectId)
    const next = nextStepOf(spine)
    if (!next || phaseUnitOf(next) !== unit) {
      return { phase: unit, stopped_at: null, reason_vi: "Đã xong giai đoạn này", steps: outcomes }
    }
    if (flagsAtStart === null) {
      flagsAtStart = {
        red: spine.flags.filter((f) => f.level === "red" && f.resolved_at === null).length,
        yellow: spine.flags.filter((f) => f.level === "yellow" && f.resolved_at === null).length
      }
    }

    emit({ type: "phase_progress", step_id: next.id, phase: unit, step_index: index + 1, step_total: Math.max(totalSteps, index + 1), needs_user: false })

    const collector = collectSignals(emit)
    await runStep(projectId, next.id, sessionId, userId, collector.emit, deps)
    const { asked, gate: gateEvent, error, renderFailed } = collector.signals

    if (error || !gateEvent) {
      return { phase: unit, stopped_at: next.id, reason_vi: error ? "Bước dừng vì lỗi" : "Bước chưa tới cổng chốt", steps: outcomes }
    }

    phaseSummary.push(...(gateEvent.summary ?? []))
    newAssumptions.push(...(gateEvent.new_assumptions ?? []))

    const { spine: afterSpine } = await load(projectId)
    const verdict: QuietVerdict = isQuietStep({
      templateId: getStep(next.id).template_id,
      reviewMode: afterSpine.project.review_mode ?? "balanced",
      asked,
      redDelta: gateEvent.flags?.red_delta ?? 0,
      newAssumptions: gateEvent.new_assumptions ?? [],
      renderFailed,
      phaseTerminal: isPhaseTerminal(afterSpine, next),
      spine: afterSpine
    })

    if (!verdict.quiet) {
      // Bước cuối giai đoạn: gửi kèm tóm tắt của cả giai đoạn để user duyệt một lần, có đủ nội dung
      emit({
        type: "phase_gate",
        step_id: next.id,
        phase: unit,
        reason_vi: verdict.reason_vi,
        summary: phaseSummary,
        new_assumptions: newAssumptions,
        steps: outcomes.map(({ step_id, label_vi, auto_accepted }) => ({ step_id, label_vi, auto_accepted })),
        ...(flagsAtStart && gateEvent.flags
          ? { flags: { red: gateEvent.flags.red, yellow: gateEvent.flags.yellow, red_delta: gateEvent.flags.red - flagsAtStart.red, yellow_delta: gateEvent.flags.yellow - flagsAtStart.yellow } }
          : {})
      })
      emit({ type: "phase_progress", step_id: next.id, phase: unit, step_index: index + 1, step_total: Math.max(totalSteps, index + 1), needs_user: true })
      return { phase: unit, stopped_at: next.id, reason_vi: verdict.reason_vi, steps: outcomes }
    }

    const accepted = await gate(projectId, next.id, userId, { action: "accept", base_version: (await load(projectId)).record.spine_version }, deps)
    void accepted
    void record
    emit({ type: "auto_accepted", step_id: next.id, reason_vi: verdict.reason_vi })
    outcomes.push({
      step_id: next.id,
      label_vi: getStep(next.id).label_vi,
      auto_accepted: true,
      reason_vi: verdict.reason_vi,
      summary: gateEvent.summary ?? []
    })
  }

  return { phase: unit, stopped_at: null, reason_vi: `Đã chạy ${MAX_PHASE_STEPS} bước liên tiếp — dừng lại để bạn xem`, steps: outcomes }
}
