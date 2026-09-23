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
import { decisionOps, filterAskedQuestions, ledgerForPrompt, sanitizeSuggestions, type AnsweredTopic } from "./decisions.service.js"
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

/** R3: một lượt hỏi gộp đầu giai đoạn, tối đa ngần này câu — hỏi nhiều hơn thì user bỏ giữa chừng. */
export const MAX_INTERVIEW_QUESTIONS = 8

/**
 * Hỏi gộp đầu giai đoạn (R3): một lượt elicit nhận hợp `empty_fields` của MỌI bước trong giai đoạn cùng
 * sổ quyết định, trả tối đa 8 câu trong một form. Trả `true` khi đã hỏi (các bước sau bỏ vòng hỏi riêng).
 *
 * Không hỏi lại điều đã chốt (sổ quyết định lọc trước), và câu trả lời ghi thẳng vào sổ nên mọi bước sau
 * đều dùng được — kể cả khi user rời máy giữa chừng rồi quay lại.
 */
const runPhaseInterview = async (
  projectId: string,
  unit: string,
  sessionId: string,
  userId: string,
  emit: Emit,
  deps: StepRunnerDeps
): Promise<boolean> => {
  const { spine } = await load(projectId)
  // Chuỗi dừng giữa chừng rồi chạy tiếp là chuyện thường (user duyệt một cổng chốt). Không nhớ đã phỏng
  // vấn giai đoạn này thì lần chạy tiếp lại hỏi lại từ đầu — mất credit và hỏi đúng thứ user vừa trả lời.
  if (spine.decisions.some((d) => d.step_id === unit && d.superseded_by === null)) return false
  const steps = orderedSteps(spine).filter((s) => phaseUnitOf(s) === unit)
  const missing = [...new Set(steps.flatMap((step) => {
    try {
      return projectStep(spine, step.id).emptyFields
    } catch {
      return []
    }
  }))]
  if (missing.length === 0) return false

  const reservedId = await meter.reserveCall(projectId, userId, unit, "elicit")
  let result
  try {
    result = await deps.elicitExecutor(
      {
        promptVariables: {
          step_id: unit,
          step_name: `Phỏng vấn đầu giai đoạn ${unit}`,
          working_mode: spine.project.working_mode ?? "coaching",
          elicit_turns_this_phase: 0,
          phase_interview: true,
          max_questions: MAX_INTERVIEW_QUESTIONS,
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

  const filtered = filterAskedQuestions(spine, result.data.questions)
  const asked = filtered.questions.slice(0, MAX_INTERVIEW_QUESTIONS)
  if (asked.length === 0) return false

  emit({ type: "elicit", step_id: unit, delta: result.data.reply })
  emit({
    type: "answer_needed",
    step_id: unit,
    questions: asked.map((q, i) => {
      const options = sanitizeSuggestions(q.topic_key, q.suggestedAnswers)
      return {
        id: `Q${i + 1}`,
        text: q.question,
        ...(options.length > 0 ? { options } : {}),
        ...(q.multiple !== undefined ? { multiple: q.multiple } : {})
      }
    })
  })

  const answers = await submitAnswerWait(projectId, unit, sessionId, deps.signal)
  emit({ type: "answer_received", step_id: unit, count: answers.length })

  // Hỏi/đáp của lượt gộp phải nằm trong transcript: user cần thấy lại trong khung chat, và các bước
  // trong giai đoạn đọc nó như câu trả lời của chính mình.
  const transcript: IChatMessage[] = [
    { role: "ai", content: [result.data.reply, ...asked.map((q, i) => `${i + 1}. ${q.question}`)].join("\n"), step: unit, createdAt: new Date() },
    ...answers.map((a) => ({
      role: "user" as const,
      content: Array.isArray(a.answer) ? a.answer.join(", ") : a.answer,
      step: unit,
      createdAt: new Date()
    }))
  ]
  await ChatSession.updateOne({ _id: sessionId }, { $push: { messages: { $each: transcript } } })

  const answered: AnsweredTopic[] = answers.flatMap((a) => {
    const index = Number(/^Q(\d+)$/.exec(a.question_id)?.[1] ?? 0) - 1
    const question = asked[index]
    if (!question) return []
    return [{ topic_key: question.topic_key, question: question.question, answer: Array.isArray(a.answer) ? a.answer.join(", ") : a.answer }]
  })

  const { record, spine: spineNow } = await load(projectId)
  const ops = decisionOps(spineNow, unit, answered)
  if (ops.length > 0) {
    await applyTransaction(projectId, { base_version: record.spine_version, ops, by: userId, step_id: null, reason: `Phỏng vấn đầu giai đoạn ${unit}` })
  }
  return true
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

  // R3: hỏi gộp đầu giai đoạn, rồi các bước bên trong không hỏi lại nữa
  const interviewed = startSpine.project.review_mode !== "strict" ? await runPhaseInterview(projectId, unit, sessionId, userId, emit, d) : false
  const stepDeps: Partial<StepRunnerDeps> = interviewed ? { ...deps, skipElicit: true } : deps

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
    await runStep(projectId, next.id, sessionId, userId, collector.emit, stepDeps)
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

    const accepted = await gate(projectId, next.id, userId, { action: "accept", base_version: (await load(projectId)).record.spine_version }, stepDeps)
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
