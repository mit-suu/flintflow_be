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

import { runStep, defaultStepRunnerDeps, recordUserMessage, B0_FIELD_STEPS, type Emit, type GateResolution, type StepRunnerDeps } from "./step-runner.service.js"
import { ChatSession, type IChatMessage } from "../project/chat-session.model.js"
import { addendumForUnit, loadConversationVariables, projectStep } from "./context-projection.js"
import { SYSTEM_NAME_FIELD, askableFields, decisionOps, filterAskedQuestions, ledgerForPrompt } from "./decisions.service.js"
import { FAST_PATH_PHASES, NO_QUESTION_ACK_VI, interviewBudget, interviewGuidance, interviewProjection, reconcileReply, trimTailQuestion, withoutQuestions } from "./fast-path.js"
import { PROMPT_QUESTIONS_PER_TURN, answerText, answeredTopics, indexOfQuestion, shapeQuestions } from "./question-shape.js"
import { CHAT_BUDGET_REPLY, askTranscript, chatBudgetLeft, nextPendingAfterChat, runChatTurn, settleWithoutModel, submitAnswerWait, type AnswerPayload } from "./step-runner.service.js"
import * as meter from "./meter.service.js"
import { applyTransaction } from "../spine/op-engine.js"
import { gate, phaseGateAssumptions } from "./gate.service.js"
import { getStep, nextStep as nextStepOf, orderedSteps, type ExpandedStep } from "./step-registry.js"
import { isQuietStep, type QuietVerdict } from "./quiet-step.js"
import { composePhaseGateMessage, spokenAssumptionIds, stripModelCountSentences } from "./gate-message.js"
import * as spineRepository from "./../spine/spine.repository.js"
import type { Spine, SpineRecord } from "../spine/spine.types.js"
import type { ChangeSummary, StepEvent } from "./pipeline.dto.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { clientErrorMessage } from "../../shared/utils/client-error.js"
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
  answers: readonly AnswerInput[],
  /** Lượt chat tự do (FLF-221): transcript đã ghi từng tin, chỉ còn sổ quyết định; câu chốt qua chat ghi sổ riêng. */
  chat: { settledIds: ReadonlySet<string> } | null = null
): Promise<void> => {
  if (!chat) {
    // Lượt hỏi vào lịch sử đúng MỘT bản, dạng JSON khung chat vẽ được: sau một lượt chat tự do nó đã được ghi (câu còn
    // chờ — `interviewChatTurn`), ghi lại ở đây thành hai tin AI cho cùng một lượt hỏi.
    const transcript: IChatMessage[] = (await hasInterviewAsk(sessionId, unit))
      ? []
      : [{ role: "ai", content: askTranscript(reply, asked), step: unit, createdAt: new Date() }]
    // Câu trả lời trên thẻ: một tin, mỗi đáp án một dòng — câu hỏi đã nằm ngay trên, không lặp lại trong bong bóng user
    const said = answers.map((a) => answerText(a.answer)).filter((text) => text !== "")
    if (said.length > 0) transcript.push({ role: "user", content: said.join("\n"), step: unit, createdAt: new Date() })
    if (transcript.length > 0) await pushInterviewMessages(projectId, sessionId, transcript)
  }

  const { record, spine: spineNow } = await load(projectId)
  const ops = decisionOps(spineNow, unit, answeredTopics(asked, answers, chat?.settledIds))
  if (ops.length > 0) {
    await applyTransaction(projectId, { base_version: record.spine_version, ops, by: userId, step_id: null, reason: `Phỏng vấn đầu giai đoạn ${unit}` })
  }
}

/** Lịch sử đã có tin AI của lượt phỏng vấn `unit` chưa. */
const hasInterviewAsk = async (sessionId: string, unit: string): Promise<boolean> => {
  const session = await ChatSession.findById(sessionId, { messages: 1 }).lean()
  return (session?.messages ?? []).some((m) => m.step === unit && m.role === "ai")
}

/** Ghi tin vào transcript của lượt phỏng vấn — lọc cả `projectId` như mọi lượt ghi transcript (FLF-221). */
const pushInterviewMessages = async (projectId: string, sessionId: string, messages: IChatMessage[]): Promise<void> => {
  await ChatSession.updateOne({ _id: sessionId, projectId }, { $push: { messages: { $each: messages } } })
}

/**
 * Một lượt chat tự do trong phỏng vấn đầu giai đoạn (FLF-221): ghi tin user, AI đọc rồi chốt câu được trả lời đúng ý
 * (server kiểm), trả lời user + nhắc câu còn chờ. Hết ngân sách chat ⇒ câu cố định, các câu còn lại để các bước tự
 * giả định. Trả các câu còn chờ (rỗng ⇒ xong phỏng vấn) và lời AI.
 */
const interviewChatTurn = async (
  projectId: string,
  unit: string,
  sessionId: string,
  userId: string,
  deps: Pick<StepRunnerDeps, "elicitExecutor">,
  asked: PendingAnswerState["asked"],
  payload: AnswerPayload,
  message: string,
  /** Lời AI lúc đặt các câu đang chờ — ghi vào lịch sử cùng câu hỏi nếu lịch sử chưa có lượt hỏi nào của giai đoạn. */
  askedReply = ""
): Promise<{ reply: string; remaining: PendingAnswerState["asked"] }> => {
  const cardAnswers = payload.answers.filter((a) => indexOfQuestion(asked, a.question_id) >= 0)
  // Lượt hỏi đầu giai đoạn chỉ vào lịch sử khi có câu trả lời trên thẻ — trả lời bằng chat thì câu hỏi biến mất khỏi
  // khung chat ngay khi user gửi. Ghi nó trước tin của user.
  if (!(await hasInterviewAsk(sessionId, unit))) {
    await pushInterviewMessages(projectId, sessionId, [{ role: "ai", content: askTranscript(askedReply, asked), step: unit, createdAt: new Date() }])
  }
  // Đáp án thẻ gửi kèm tin gõ vào transcript TRƯỚC lượt chat: model đọc transcript để biết user đã chọn gì, thiếu thì hỏi lại
  const pickedByCard = cardAnswers.map((a) => answerText(a.answer)).filter((text) => text !== "")
  if (pickedByCard.length > 0) {
    await pushInterviewMessages(projectId, sessionId, [{ role: "user", content: pickedByCard.join("\n"), step: unit, createdAt: new Date() }])
  }
  if (!payload.messageRecorded) {
    await pushInterviewMessages(projectId, sessionId, [{ role: "user", content: message, step: unit, createdAt: new Date() }])
  }
  const { spine } = await load(projectId)
  // Fast path (B-1): lượt hỏi gộp là lượt hỏi DUY NHẤT — tin chat sau đó chỉ được đọc & chốt, rồi đóng phỏng vấn (không hỏi thêm,
  // không hỏi lại). Điều còn chưa trả lời không vào sổ quyết định: các bước viết gắn nó thành giả định và cổng cuối nói ra.
  const closing = FAST_PATH_PHASES.has(unit)
  if (!(await chatBudgetLeft(projectId, unit, null))) {
    // Chốt phần tin nhắn đã trả lời trước; chỉ câu thật sự chưa trả lời mới để các bước tự giả định
    const byCard = new Set(cardAnswers.map((a) => indexOfQuestion(asked, a.question_id)))
    const local = settleWithoutModel(asked, message, !closing).filter((a) => !byCard.has(indexOfQuestion(asked, a.question_id)))
    await recordInterviewAnswers(projectId, unit, sessionId, userId, "", asked, [...cardAnswers, ...local], {
      settledIds: new Set(local.map((a) => a.question_id))
    })
    const answeredNow = new Set([...cardAnswers, ...local].map((a) => indexOfQuestion(asked, a.question_id)))
    if (asked.every((_, i) => answeredNow.has(i))) return { reply: "", remaining: [] }
    await pushInterviewMessages(projectId, sessionId, [{ role: "ai", content: CHAT_BUDGET_REPLY, step: unit, createdAt: new Date() }])
    return { reply: CHAT_BUDGET_REPLY, remaining: [] }
  }
  const turn = await runChatTurn({
    projectId,
    userId,
    unit,
    stepName: `Phỏng vấn đầu giai đoạn ${unit}`,
    asked,
    message,
    // Lời AI lúc đặt các câu đang chờ + tin user: thiếu lời AI thì model không biết user đang trả lời câu nào
    recentTurns: [askedReply ? `AI: ${askedReply}` : "", `User: ${message}`].filter((t) => t !== "").join("\n"),
    // Đọc lại transcript cả session (tóm tắt + lượt gần nhất), không chỉ hai dòng trên
    sessionId,
    projection: {},
    spine,
    elicitExecutor: deps.elicitExecutor,
    ...(closing ? { closing } : {})
  })
  const byCard = new Set(cardAnswers.map((a) => indexOfQuestion(asked, a.question_id)))
  const settled = turn.settled.filter((a) => !byCard.has(indexOfQuestion(asked, a.question_id)))
  await recordInterviewAnswers(projectId, unit, sessionId, userId, turn.reply, asked, [...cardAnswers, ...settled], {
    settledIds: new Set(settled.map((a) => a.question_id))
  })
  const answered = new Set([...cardAnswers, ...settled].map((a) => indexOfQuestion(asked, a.question_id)))
  if (closing) {
    const closingReply = withoutQuestions(turn.reply)
    await pushInterviewMessages(projectId, sessionId, [{ role: "ai", content: closingReply, step: unit, createdAt: new Date() }])
    return { reply: closingReply, remaining: [] }
  }
  const { spine: after } = await load(projectId)
  const remaining = nextPendingAfterChat(after, asked.filter((_, i) => !answered.has(i)), turn.questions, message)
  // Câu hỏi đuôi trong lời AI tính vào trần câu hỏi của lượt (FLF-235): đã hỏi lại đủ câu thì không còn "bạn thấy hợp lý chứ?"
  const reply = trimTailQuestion(turn.reply, remaining, PROMPT_QUESTIONS_PER_TURN)
  await pushInterviewMessages(projectId, sessionId, [{ role: "ai", content: askTranscript(reply, remaining), step: unit, createdAt: new Date() }])
  return { reply, remaining }
}

/**
 * `/answer` cho lượt phỏng vấn đầu giai đoạn đã tách khỏi kết nối: ghi câu trả lời rồi đóng lượt (`done`).
 * Không tự chạy cả giai đoạn ở nền — FE chạy lại giai đoạn, phỏng vấn tự bỏ vì chủ đề đã chốt. Có tin chat tự do
 * (FLF-221) ⇒ AI đọc nó; còn câu chờ thì lượt quay lại `waiting_answer` với các câu đó, không đóng.
 */
export const resumePhaseInterview = async (
  projectId: string,
  unit: string,
  userId: string,
  pending: PendingAnswerState,
  payload: AnswerPayload,
  deps: Partial<StepRunnerDeps> = {}
): Promise<void> => {
  const { answers } = payload
  const message = payload.message?.trim()
  // Chiếm khoá để hai `/answer` cùng lúc không ghi hai lần (lượt sau 409)
  const run = await acquireRun(projectId, unit, { sessionId: pending.session_id, by: userId, stage: "ask", detail_vi: message ? "Đang đọc tin nhắn của bạn" : `Đã nhận ${answers.length} câu trả lời` })
  try {
    if (message) {
      const d: StepRunnerDeps = { ...defaultStepRunnerDeps(), ...deps }
      const { reply, remaining } = await interviewChatTurn(projectId, unit, pending.session_id, userId, d, pending.asked, payload, message, pending.reply ?? "")
      if (remaining.length > 0) {
        const { questions } = shapeQuestions(remaining)
        const elicit: StepEvent = { type: "elicit", step_id: unit, delta: reply }
        await touchRun(projectId, unit, run.run_id, { appendEvent: { ...elicit, at: new Date().toISOString() } })
        await touchRun(projectId, unit, run.run_id, {
          status: "waiting_answer",
          stage: "ask",
          detail_vi: `Chờ bạn trả lời ${questions.length} câu`,
          questions,
          pending_answer: { ...pending, asked: remaining, reply },
          release: true,
          appendEvent: { type: "answer_needed", step_id: unit, questions, at: new Date().toISOString() }
        })
        return
      }
    } else {
      await recordInterviewAnswers(projectId, unit, pending.session_id, userId, pending.reply ?? "", pending.asked, answers)
    }
    await finishRun(projectId, unit, run.run_id, "done", { questions: null })
  } catch (err) {
    await finishRun(projectId, unit, run.run_id, "interrupted", { error: { code: err instanceof ApiError ? err.code : "UNKNOWN", message: clientErrorMessage(err) } })
    throw err
  }
}

/**
 * Kết quả lượt phỏng vấn: bỏ qua trước khi gọi model (`skipped`), gọi model nhưng không có gì để hỏi (`asked_none`), đã có
 * câu trả lời (`answered`), hoặc lượt chờ tách khỏi kết nối (`detached`). `answered` và `asked_none` = lượt hỏi gộp đã ĐỌC tin
 * user mở giai đoạn.
 */
type InterviewOutcome = "skipped" | "asked_none" | "answered" | "detached"

/**
 * Hỏi gộp đầu giai đoạn (R3): một lượt elicit nhận hợp `empty_fields` của MỌI bước trong giai đoạn cùng
 * sổ quyết định, trả tối đa `MAX_QUESTIONS_PER_TURN` câu (FLF-220 — cùng trần với mọi lượt hỏi). Chạy ở
 * mọi chế độ duyệt.
 *
 * Lượt chờ ghi ở run-state của đơn vị giai đoạn (`step_runs` với `step_id` = `unit`) để reload dựng lại thẻ hỏi
 * và `/answer` ghi được câu trả lời kể cả khi kết nối đã đóng (FLF-222).
 *
 * Không hỏi lại điều đã chốt (sổ quyết định lọc trước), và câu trả lời ghi thẳng vào sổ nên mọi bước sau
 * đều dùng được — kể cả khi user rời máy giữa chừng rồi quay lại. Điều còn thiếu thì step bên trong tự hỏi, trừ giai đoạn fast
 * path (B-1, `fast-path.ts`): đó là lượt hỏi duy nhất, điều không hỏi được thành giả định.
 */
/**
 * B-0 không phỏng vấn gộp (FLF-221): user vừa kể ý tưởng ở B-0.1, B-0.2/B-0.3 chỉ chốt hai field B-0.1 thường đã suy
 * ra — một lượt hỏi gộp ở đây vừa tốn một lượt model vừa hỏi lại điều user chưa kịp nói.
 */
export const PHASES_WITHOUT_INTERVIEW: ReadonlySet<string> = new Set(["B-0"])

const runPhaseInterview = async (
  projectId: string,
  unit: string,
  sessionId: string,
  userId: string,
  emit: Emit,
  deps: StepRunnerDeps,
  userMessage?: string
): Promise<InterviewOutcome> => {
  if (PHASES_WITHOUT_INTERVIEW.has(unit)) return "skipped"
  const { spine } = await load(projectId)
  // Chuỗi dừng giữa chừng rồi chạy tiếp là chuyện thường (user duyệt một cổng chốt). Không nhớ đã phỏng
  // vấn giai đoạn này thì lần chạy tiếp lại hỏi lại từ đầu — mất credit và hỏi đúng thứ user vừa trả lời.
  if (spine.decisions.some((d) => d.step_id === unit && d.superseded_by === null)) return "skipped"
  // Câu trả lời mở gõ gộp một đoạn không vào sổ quyết định (FLF-220) ⇒ sổ không đủ làm dấu "đã phỏng vấn".
  // Transcript của lượt phỏng vấn (lưu với `step` = đơn vị giai đoạn) thì luôn có.
  const session = await ChatSession.findById(sessionId, { messages: 1 }).lean()
  // Fast path: tin mở giai đoạn của user cũng được ghi dưới đơn vị (để mọi bước B-1.x thấy nó), nên dấu "đã phỏng vấn" là
  // lời AI của lượt phỏng vấn — lượt không hỏi gì (`asked_none`) cũng ghi một lời AI để làm dấu này.
  const fast = FAST_PATH_PHASES.has(unit)
  if ((session?.messages ?? []).some((m) => m.step === unit && (!fast || m.role === "ai"))) return "skipped"
  const steps = orderedSteps(spine).filter((s) => phaseUnitOf(s) === unit)
  // Tên hệ thống chỉ do chính B-2.3 hỏi: hợp field của mọi bước có B-2.3 nhưng phỏng vấn đầu giai đoạn không được hỏi nó sớm hơn
  const missing = [...new Set(steps.flatMap((step) => {
    try {
      return askableFields(getStep(step.id).template_id, projectStep(spine, step.id).emptyFields)
    } catch {
      return []
    }
  }))].filter((field) => field !== SYSTEM_NAME_FIELD)
  if (missing.length === 0) return "skipped"

  const run = await acquireRun(projectId, unit, { sessionId, by: userId, stage: "ask", detail_vi: "Xem giai đoạn này còn thiếu gì để hỏi bạn" })
  if (deps.abort) registerAbort(run.run_id, deps.abort)
  let outcome: InterviewOutcome | null = null
  try {
    outcome = await askPhaseInterview(projectId, unit, sessionId, userId, emit, deps, spine, missing, run.run_id, userMessage)
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
  runId: string,
  userMessage?: string
): Promise<InterviewOutcome> => {
  const conversation = await loadConversationVariables(sessionId, spine)
  // Fast path (FLF-234): đây là lượt hỏi DUY NHẤT của giai đoạn ⇒ thấy việc của mọi bước, hỏi nhiều/ít theo mức độ quan trọng
  const fast = FAST_PATH_PHASES.has(unit)
  const budget = fast ? interviewBudget(spine.project.stakes) : PROMPT_QUESTIONS_PER_TURN
  const reservedId = await meter.reserveCall(projectId, userId, unit, "elicit")
  let result
  try {
    result = await deps.elicitExecutor(
      {
        promptVariables: {
          step_id: unit,
          step_name: `Phỏng vấn đầu giai đoạn ${unit}`,
          phase_interview: true,
          max_questions: budget,
          fast_path: fast,
          missing,
          pending_questions: [],
          projection: fast ? interviewProjection(spine, unit) : {},
          addendum: addendumForUnit(spine, unit),
          content_guidance: fast ? interviewGuidance(spine, unit) : "",
          decisions: ledgerForPrompt(spine),
          // FLF-221: user mở giai đoạn bằng một tin chat — lượt hỏi gộp phải thấy điều user vừa nói. FLF-232: kèm đuôi hội
          // thoại của các bước trước, để sang giai đoạn mới AI nối mạch thay vì chào lại.
          ...conversation,
          user_message: userMessage ?? "(tự động — hỏi gộp đầu giai đoạn)"
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

  const unasked = filterAskedQuestions(spine, result.data.questions).questions
  // Server cắt theo ngân sách: không tin model đếm đúng
  const { asked, questions } = shapeQuestions(fast ? unasked.slice(0, budget) : unasked)
  // Fast path: câu model hỏi mà server bỏ (đã chốt / quá ngân sách) thì lời AI cũng không được còn hỏi nó
  const askedTexts = asked.map((a) => a.question)
  const firstReply = trimTailQuestion(
    fast ? reconcileReply(result.data.reply, result.data.questions.filter((q) => !asked.some((a) => a.question === q.question)).map((q) => q.question), askedTexts) : result.data.reply,
    asked,
    budget
  )
  if (asked.length === 0) {
    // Lượt phỏng vấn không hỏi gì (chỉ fast path tới được đây với tin của user): vẫn trả lời user và ghi lời AI vào transcript
    // dưới đơn vị — đó là dấu "đã phỏng vấn", để chạy lại / vào lại giai đoạn không gọi model hỏi thêm lần nữa.
    const ack = firstReply.trim() === "" ? NO_QUESTION_ACK_VI : firstReply
    if (fast) {
      emit({ type: "elicit", step_id: unit, delta: ack })
      await pushInterviewMessages(projectId, sessionId, [{ role: "ai", content: ack, step: unit, createdAt: new Date() }])
    }
    return "asked_none"
  }

  emit({ type: "elicit", step_id: unit, delta: firstReply })
  const answerNeeded: StepEvent = { type: "answer_needed", step_id: unit, questions }
  emit(answerNeeded)
  await touchRun(projectId, unit, runId, {
    status: "waiting_answer",
    stage: "ask",
    detail_vi: `Chờ bạn trả lời ${questions.length} câu`,
    questions,
    pending_answer: { kind: "phase_interview", unit, session_id: sessionId, asked, base_answers_text: "", reply: firstReply },
    release: true,
    appendEvent: { ...answerNeeded, at: new Date().toISOString() }
  })

  // Vòng chờ: thẻ ⇒ ghi ngay; chat tự do ⇒ AI đọc, chốt câu đúng ý, hỏi lại câu còn chờ (FLF-221)
  let pending = asked
  let reply = firstReply
  for (;;) {
    let payload: AnswerPayload
    try {
      payload = await submitAnswerWait(projectId, unit, sessionId, deps.signal)
    } catch (err) {
      if (err instanceof AnswerDetached) return "detached"
      throw err
    }
    const message = payload.message?.trim()
    const cardAnswers = payload.answers.filter((a) => indexOfQuestion(pending, a.question_id) >= 0)
    emit({ type: "answer_received", step_id: unit, count: cardAnswers.length })
    if (!message) {
      await recordInterviewAnswers(projectId, unit, sessionId, userId, reply, pending, cardAnswers)
      return "answered"
    }
    const turn = await interviewChatTurn(projectId, unit, sessionId, userId, deps, pending, payload, message, reply)
    if (turn.reply) emit({ type: "elicit", step_id: unit, delta: turn.reply })
    if (turn.remaining.length === 0) return "answered"
    pending = turn.remaining
    reply = turn.reply
    const { questions: again } = shapeQuestions(pending)
    const askAgain: StepEvent = { type: "answer_needed", step_id: unit, questions: again }
    emit(askAgain)
    await touchRun(projectId, unit, runId, {
      status: "waiting_answer",
      stage: "ask",
      detail_vi: `Chờ bạn trả lời ${again.length} câu`,
      questions: again,
      pending_answer: { kind: "phase_interview", unit, session_id: sessionId, asked: pending, base_answers_text: "", reply },
      release: true,
      appendEvent: { ...askAgain, at: new Date().toISOString() }
    })
  }
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
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  return { record, spine: stripRecord(record) }
}

interface PhaseDecision {
  verdict: QuietVerdict
  afterSpine: Spine
  /** Chỉ có khi cổng thật: sự kiện `phase_gate` đầy đủ (tin nhắn + mọi giả định cả giai đoạn). */
  phaseGate: Extract<StepEvent, { type: "phase_gate" }> | null
}

const toResolution = (d: PhaseDecision): GateResolution => (d.verdict.quiet ? { quiet: true } : { quiet: false, phaseGate: d.phaseGate ?? undefined })

interface DecideInput {
  projectId: string
  next: ExpandedStep
  unit: string
  gateEvent: Extract<StepEvent, { type: "gate_ready" }>
  signals: StepSignals
  phaseSummary: ChangeSummary[]
  outcomes: PhaseStepOutcome[]
  flagsAtStart: { red: number; yellow: number } | null
}

/** Bước vừa tới gate: im (tự Accept) hay dừng chờ user; nếu dừng thì dựng sẵn `phase_gate`. Gọi đúng một lần mỗi bước. */
const decideStep = async ({ projectId, next, unit, gateEvent, signals, phaseSummary, outcomes, flagsAtStart }: DecideInput): Promise<PhaseDecision> => {
  phaseSummary.push(...(gateEvent.summary ?? []))
  const { spine: afterSpine } = await load(projectId)
  const templateId = getStep(next.id).template_id
  const verdict: QuietVerdict = isQuietStep({
    templateId,
    reviewMode: afterSpine.project.review_mode ?? "balanced",
    asked: signals.asked,
    redDelta: gateEvent.flags?.red_delta ?? 0,
    newAssumptions: gateEvent.new_assumptions ?? [],
    renderFailed: signals.renderFailed,
    phaseTerminal: isPhaseTerminal(afterSpine, next),
    // B-0.2/B-0.3 bỏ qua vì B-0.1 đã chốt field: không gọi model, không ghi gì ⇒ không có gì để duyệt
    settledEarlier: B0_FIELD_STEPS[templateId] !== undefined && !signals.asked && gateEvent.calls_used === 0 && gateEvent.wrote_ops === false,
    spine: afterSpine
  })
  if (verdict.quiet) return { verdict, afterSpine, phaseGate: null }

  // FLF-232 giữ ý định, FLF-241 đổi cách làm: `new_assumptions` của cổng vẫn là đúng danh sách tin nói ra (chip "Đúng rồi"
  // chỉ xác nhận chúng), nhưng tin không còn nối một câu cho từng điều tạm hiểu còn lại của giai đoạn — đo được 8 câu nối
  // nhau ở B-1.6. Phần không được nói chỉ còn MỘT câu đếm để user biết còn nợ gì, và không vào `new_assumptions`: nó ở lại
  // `unconfirmed`, S-9.1 gom và cờ đỏ chặn ký baseline. Tập đầy đủ dựng từ Spine, không từ bộ nhớ của lần chạy này: chạy
  // tiếp sau khi tải lại thì các bước im của lượt trước không còn ở đó.
  const phaseAssumptions = phaseGateAssumptions(afterSpine, next.id)
  // Đo trên bản ĐÃ bỏ câu đếm model tự viết, vì đó là lời sẽ bị gỡ khỏi tin cuối: đo trên bản chưa lọc thì điều chỉ được
  // nhắc trong câu đó bị tính là đã nói rồi câu đó biến mất ⇒ `new_assumptions` chứa id tin không nói, và N bị thiếu.
  const spokenFrom = stripModelCountSentences(gateEvent.message_vi)
  const spokenIds = spokenAssumptionIds(spokenFrom, phaseAssumptions)
  const spokenAssumptions = phaseAssumptions.filter((a) => spokenIds.has(a.id))
  const phaseMessage = composePhaseGateMessage({
    lastMessage: spokenFrom,
    unspokenCount: phaseAssumptions.length - spokenAssumptions.length
  })
  const phaseGate: Extract<StepEvent, { type: "phase_gate" }> = {
    type: "phase_gate",
    step_id: next.id,
    phase: unit,
    reason_vi: verdict.reason_vi,
    summary: phaseSummary,
    new_assumptions: spokenAssumptions,
    steps: outcomes.map(({ step_id, label_vi, auto_accepted }) => ({ step_id, label_vi, auto_accepted })),
    ...(phaseMessage ? { message_vi: phaseMessage } : {}),
    ...(flagsAtStart && gateEvent.flags
      ? { flags: { red: gateEvent.flags.red, yellow: gateEvent.flags.yellow, red_delta: gateEvent.flags.red - flagsAtStart.red, yellow_delta: gateEvent.flags.yellow - flagsAtStart.yellow } }
      : {})
  }
  return { verdict, afterSpine, phaseGate }
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
  let flagsAtStart: { red: number; yellow: number } | null = null

  // FLF-221: chat là nút chạy — tin nhắn mở giai đoạn vào transcript gắn với bước ĐẦU sẽ chạy (không gắn đơn vị giai
  // đoạn: tin gắn đơn vị bị coi là "đã phỏng vấn"). Ghi trước lượt phỏng vấn để thứ tự hội thoại đúng; kiểm session
  // trước khi ghi. Chỉ bước đầu nhận message/intent — các bước sau là lượt chạy tiếp, không phải lời user.
  const message = deps.message?.trim() ? deps.message.trim() : undefined
  // Fast path: tin mở B-1 gắn đơn vị để bước B-1.2… (chỉ đọc transcript của đơn vị + bước mình) cũng thấy nó; dấu "đã phỏng vấn"
  // là lời AI (xem `runPhaseInterview`), không phải tin user.
  const openingStep = FAST_PATH_PHASES.has(unit) && orderedSteps(startSpine).find((s) => phaseUnitOf(s) === unit)?.id === first.id ? unit : first.id
  if (message) await recordUserMessage(projectId, sessionId, openingStep, message)
  const { message: _message, intent: _intent, messageRecorded: _recorded, ...laterDeps } = deps
  const firstDepsWith = (messageForStep: string | undefined): Partial<StepRunnerDeps> => ({
    ...laterDeps,
    ...(message ? { messageRecorded: true } : {}),
    ...(messageForStep ? { message: messageForStep } : {}),
    ...(deps.intent ? { intent: deps.intent } : {})
  })

  // R3 + FLF-220: hỏi gộp đầu giai đoạn ở mọi chế độ duyệt (trừ B-0). Các bước bên trong vẫn hỏi được khi còn field
  // trống (trừ fast path B-1) — sổ quyết định chặn lặp lại chủ đề vừa trả lời ở đây.
  const interview = await runPhaseInterview(projectId, unit, sessionId, userId, emit, d, message)
  // Kết nối đóng trong lúc chờ trả lời phỏng vấn: dừng chuỗi, câu hỏi nằm ở run-state của giai đoạn (FLF-222)
  if (interview === "detached") return { phase: unit, stopped_at: unit, reason_vi: "Chờ bạn trả lời câu hỏi đầu giai đoạn", steps: [] }
  // Fast path: lượt hỏi gộp đã đọc tin này ⇒ bước đầu không nhận lại nó (sẽ kích một lượt Elicit thừa); tin vẫn đã được ghi.
  const interviewReadMessage = FAST_PATH_PHASES.has(unit) && (interview === "answered" || interview === "asked_none")
  let firstDeps: Partial<StepRunnerDeps> | null = firstDepsWith(interviewReadMessage ? undefined : message)

  /** Bước cuối giai đoạn vừa được tự Accept (không có cổng chốt nào của giai đoạn này cho user). */
  let terminalAutoAccepted = false
  for (let index = 0; index < MAX_PHASE_STEPS; index++) {
    const { record, spine } = await load(projectId)
    const next = nextStepOf(spine)
    if (!next || phaseUnitOf(next) !== unit) {
      // Cả giai đoạn tự qua (B-0 khi B-0.1 đã chốt nền tảng + mức độ): chạy luôn giai đoạn kế trên cùng luồng —
      // dừng ở đây thì user đứng trước một khung trống, không biết phải gõ gì để đi tiếp.
      if (next && terminalAutoAccepted) return runPhase(projectId, phaseUnitOf(next), sessionId, userId, emit, laterDeps)
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
    const stepDeps = firstDeps ?? laterDeps
    firstDeps = null

    // Quyết "im hay cổng thật" NGAY khi gate_ready sẵn sàng (trước khi step-runner ghi run-state/phát cổng): bước im không được lộ
    // thẻ cổng có chip trong lúc chờ tự Accept, và cổng chốt cuối giai đoạn được ghi vào run-state để sống qua reload.
    let decision: PhaseDecision | null = null
    const decide = async (gateEvent: Extract<StepEvent, { type: "gate_ready" }>): Promise<PhaseDecision> => {
      if (decision) return decision
      decision = await decideStep({ projectId, next, unit, gateEvent, signals: collector.signals, phaseSummary, outcomes, flagsAtStart })
      return decision
    }
    await runStep(projectId, next.id, sessionId, userId, collector.emit, { ...stepDeps, resolveGate: async (g) => toResolution(await decide(g)) })
    const { gate: gateEvent, error } = collector.signals

    if (error || !gateEvent) {
      return { phase: unit, stopped_at: next.id, reason_vi: error ? "Bước dừng vì lỗi" : "Bước chưa tới cổng chốt", steps: outcomes }
    }

    const { verdict, afterSpine, phaseGate } = await decide(gateEvent)

    if (!verdict.quiet) {
      // Bước cuối giai đoạn: gửi kèm tóm tắt của cả giai đoạn để user duyệt một lần, có đủ nội dung
      emit(phaseGate as Extract<StepEvent, { type: "phase_gate" }>)
      emit({ type: "phase_progress", step_id: next.id, phase: unit, step_index: index + 1, step_total: Math.max(totalSteps, index + 1), needs_user: true })
      return { phase: unit, stopped_at: next.id, reason_vi: verdict.reason_vi, steps: outcomes }
    }

    const accepted = await gate(projectId, next.id, userId, { action: "accept", base_version: (await load(projectId)).record.spine_version }, laterDeps)
    void accepted
    void record
    emit({ type: "auto_accepted", step_id: next.id, reason_vi: verdict.reason_vi })
    terminalAutoAccepted = isPhaseTerminal(afterSpine, next)
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
