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
 *
 * F2 (review T13): trần 8 lượt chỉ kiểm ở cửa vào là chưa đủ — hai lượt gọi khác nhau (elicit rồi draft)
 * trong CÙNG một `runStep` có thể lần lượt vượt trần nếu chỉ kiểm một lần. Mỗi lượt gọi model (elicit,
 * draft/regenerate/revision qua `runDraftPhase`, review qua `runRenderReviewPhase`) tự kiểm trần + ghi
 * usage `reserved` NGAY TRƯỚC khi gọi model (xem `meter.service.ts`). Đồng thời khoá in-process theo
 * `${projectId}:${stepId}` (`acquireStepLock`/`releaseStepLock`) chặn `/run`, `/gate`, resume chạy đồng
 * thời trên cùng step — 409 STEP_NOT_RUNNABLE cho request thứ hai. Giả định single-instance (một tiến
 * trình Node) — xem `docs/spec-gaps.md`.
 */

import { randomUUID } from "node:crypto"
import { env } from "../../config/env.js"
import { ChatSession, type IChatMessage } from "../project/chat-session.model.js"
import { Project } from "../project/project.model.js"
import { assemble } from "../render/assemble.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { applyTransaction, CHANGE_RANGE_INVALID } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import type { Spine, SpineRecord, StepState } from "../spine/spine.types.js"
import * as flagsService from "../spine/flags.service.js"
import { renderDiagrams, staleRenderedDiagrams, type DiagramServiceDeps } from "../diagram/diagram.service.js"
import type { RenderTarget } from "../diagram/renderers/index.js"
import { NONSCREEN_LOOP, getStep, nextStep as nextStepOf } from "./step-registry.js"
import { buildStepContext, elicitProjection, getStepSpec, parseStepId, type StepContext } from "./context-projection.js"
import { decisionOps, filterAskedQuestions, ledgerForPrompt, sanitizeSuggestions, type AnsweredTopic } from "./decisions.service.js"
import { draftOps, type DraftCallKind, type DraftExecutor } from "./draft-to-ops.js"
import { S9_FREE_STEPS, S9_PHASE, runS9Step } from "./s9/run-s9-step.js"
import * as meter from "./meter.service.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"
import type { ElicitOutput, OpTransaction, ReviewOutput } from "../../shared/ai/response-parser.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { PIPELINE_ERROR_STATUS, gateActionSchema, type ChangeSummary, type PipelineErrorCode, type StepEvent } from "./pipeline.dto.js"
import { summarizeChanges } from "./change-summary.js"
import { gateTableOf } from "./gate-table.js"
import { buildProgressReport, computeSectionStates } from "../spine/section-status.js"
import { ownerStepOf } from "../spine/section-registry.js"
import { CALL_LIMIT, NOT_PIPELINE_SESSION, STEP_NOT_RUNNABLE } from "./step-runner.errors.js"
import {
  HEARTBEAT_MS,
  acquireRun,
  finishRun,
  registerAbort,
  touchRun,
  unregisterAbort,
  type RunStage
} from "./run-state.service.js"
import type { z } from "zod"

type GateAction = z.infer<typeof gateActionSchema>

export { CALL_LIMIT, NOT_PIPELINE_SESSION, STEP_NOT_RUNNABLE }
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
  /** Chỉ dùng khi `REVIEW_LLM_ENABLED=true` (mặc định tắt). */
  reviewExecutor: ReviewExecutor
  renderDeps?: Partial<DiagramServiceDeps>
  /** S-8.2: ghép RenderedDocument ở `spineVersion` và lưu cache — mặc định gọi `assemble()` (T15). */
  assembleDocument: (projectId: string, spineVersion: number) => Promise<void>
  /** F8: đóng tab/mất mạng giữa chừng — controller abort khi `req` đóng. Runner kiểm trước mỗi lượt gọi
   *  model và khi đang chờ answer; không áp dụng cho `/gate` (không SSE, không có kết nối để huỷ). */
  signal?: AbortSignal
  /** WP-4: cùng controller với `signal`, để `POST /cancel` huỷ được lượt này từ một request khác. */
  abort?: AbortController
  /**
   * R3: câu hỏi của cả giai đoạn đã được hỏi gộp ở đầu phase (`phase-runner`), nên bước này không hỏi
   * nữa — vừa đỡ một lượt gọi model mỗi bước, vừa giữ lời hứa "trả lời một lần rồi rời máy".
   */
  skipElicit?: boolean
}

/** `signal` đi thẳng xuống provider: huỷ lượt là huỷ luôn request HTTP tới model, không chờ nó soạn xong (BUG-05). */
export const defaultStepRunnerDeps = (signal?: AbortSignal): StepRunnerDeps => ({
  draftExecutor: (actionType, input, projectId, userId) => executeAiAction<OpTransaction>(actionType, input, projectId, userId, { signal }),
  elicitExecutor: (input, projectId, userId) => executeAiAction<ElicitOutput>(ActionType.ELICIT, input, projectId, userId, { signal }),
  reviewExecutor: (input, projectId, userId) => executeAiAction<ReviewOutput>(ActionType.REVIEW, input, projectId, userId, { signal }),
  assembleDocument: async (projectId, spineVersion) => {
    const project = await Project.findById(projectId, { name: 1 }).lean()
    if (!project) throw new ApiError(404, "Project not found or unauthorized", "PROJECT_NOT_FOUND")
    await assemble(projectId, project.name, spineVersion)
  }
})

/**
 * S-8.2 là step tất định, không skill ⇒ không Elicit/Draft. Việc thật của nó là ghép tài liệu: trước đây
 * runner chỉ tính cờ rồi phát `gate_ready`, `POST /assemble` không được gọi ở đâu ⇒ `/document` và
 * `/export/word` luôn 409 NO_WORKING_DRAFT dù S-8.2 đã accepted.
 */
export const ASSEMBLE_STEP = "S-8.2"

// ─── tiến trình trực tiếp: stage + heartbeat (03-live-status-flow §5) ───

/** Nhãn tiếng Việt của từng stage — "đang làm gì", nói việc chứ không nói quy trình nội bộ. */
export const STAGE_LABELS: Readonly<Record<RunStage, string>> = Object.freeze({
  intake: "Đọc dữ liệu của bước",
  ask: "Hỏi bạn vài câu",
  draft: "AI đang soạn nội dung",
  check: "Kiểm tra quy tắc và tham chiếu",
  render: "Vẽ lại sơ đồ",
  gate: "Chờ bạn duyệt"
})

/**
 * Một lượt chạy đang mở: phát sự kiện SSE và ghi trạng thái vào `step_runs` để reload dựng lại được
 * (BUG-07), đồng thời gia hạn khoá (BUG-05). Ghi DB là fire-and-forget với sự kiện thường; trạng thái quan
 * trọng (đang chờ trả lời, gate) thì `await` để không mất nếu tiến trình chết ngay sau đó.
 */
export interface RunTracker {
  runId: string
  startedAt: number
  emit: Emit
  stage: (stage: RunStage, extra?: { detail_vi?: string; batch?: { i: number; n: number } }) => void
  save: (patch: Parameters<typeof touchRun>[3]) => Promise<void>
  /** Phát `heartbeat` mỗi `HEARTBEAT_MS` trong lúc chờ model/render; luôn dọn ở `finally`. */
  beat: <T>(stage: RunStage, run: () => Promise<T>) => Promise<T>
}

export const createTracker = (projectId: string, stepId: string, runId: string, emit: Emit): RunTracker => {
  const startedAt = Date.now()
  let currentStage: RunStage = "intake"

  const tracked: Emit = (event) => {
    emit(event)
    if (event.type !== "heartbeat") void touchRun(projectId, stepId, runId, { appendEvent: event })
  }

  return {
    runId,
    startedAt,
    emit: tracked,
    stage: (stage, extra = {}) => {
      currentStage = stage
      const detail = extra.detail_vi
      emit({
        type: "stage",
        step_id: stepId,
        stage,
        label_vi: STAGE_LABELS[stage],
        ...(detail ? { detail_vi: detail } : {}),
        ...(extra.batch ? { batch: extra.batch } : {})
      })
      void touchRun(projectId, stepId, runId, { stage, detail_vi: detail ?? null, batch: extra.batch ?? null })
    },
    save: async (patch) => {
      await touchRun(projectId, stepId, runId, patch)
    },
    beat: async (stage, run) => {
      currentStage = stage
      const timer = setInterval(() => {
        emit({ type: "heartbeat", step_id: stepId, stage: currentStage, elapsed_ms: Date.now() - startedAt })
        void touchRun(projectId, stepId, runId, {})
      }, HEARTBEAT_MS)
      // Node: nhịp heartbeat không được giữ tiến trình sống thêm
      timer.unref?.()
      try {
        return await run()
      } finally {
        clearInterval(timer)
      }
    }
  }
}

// ─── F13: revert không được đụng change ngoài step ──────────────────

/**
 * `revertRange` (op-engine) áp nghịch đảo cả dải theo seq, kể cả change không thuộc step (vd user sửa tay
 * qua `POST /changes` xen giữa dải của step). Kiểm trước, từ chối thay vì revert âm thầm đè lên thay đổi
 * không thuộc step. Dùng ở gate regenerate + resume.
 */
export const assertRangeOwnedByStep = async (projectId: string, stepId: string, firstSeq: number, lastSeq: number): Promise<void> => {
  const changes = await spineRepository.listChanges(projectId, { fromSeq: firstSeq, toSeq: lastSeq })
  const foreign = changes.find((c) => c.step_id !== stepId)
  if (foreign) {
    throw new ApiError(422, `Dải seq ${firstSeq}–${lastSeq} của step ${stepId} chứa thay đổi không thuộc step (seq ${foreign.seq})`, CHANGE_RANGE_INVALID)
  }
}

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

/** F8: đang chờ answer mà client đóng kết nối ⇒ dọn lượt chờ, không treo promise vô thời hạn. */
const waitForAnswer = (projectId: string, stepId: string, sessionId: string, signal?: AbortSignal): Promise<AnswerInput[]> => {
  const key = answerKey(projectId, stepId, sessionId)
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      pendingAnswers.delete(key)
      if (signal && onAbort) signal.removeEventListener("abort", onAbort)
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new ApiError(409, `Hết thời gian chờ trả lời câu hỏi của step ${stepId}`, STEP_NOT_RUNNABLE))
    }, ANSWER_WAIT_TIMEOUT_MS)
    const onAbort = (): void => {
      clearTimeout(timeout)
      cleanup()
      reject(new ApiError(409, `Client đã đóng kết nối trong khi chờ trả lời step ${stepId}`, STEP_NOT_RUNNABLE))
    }
    if (signal?.aborted) {
      clearTimeout(timeout)
      reject(new ApiError(409, `Client đã đóng kết nối trong khi chờ trả lời step ${stepId}`, STEP_NOT_RUNNABLE))
      return
    }
    signal?.addEventListener("abort", onAbort)
    pendingAnswers.set(key, {
      resolve: (answers) => {
        clearTimeout(timeout)
        cleanup()
        resolve(answers)
      },
      timeout
    })
  })
}

/**
 * Chờ user trả lời một lượt hỏi ngoài khung một bước — dùng cho lượt hỏi gộp đầu giai đoạn (R3), nơi
 * `stepId` là đơn vị giai đoạn (`S-4`, `S-5@S03`) chứ không phải một bước trong registry.
 */
export const submitAnswerWait = waitForAnswer

/** F8: kiểm huỷ TRƯỚC mỗi lượt gọi model — không gọi model nữa nếu client đã đóng kết nối. */
const assertNotAborted = (signal: AbortSignal | undefined, stepId: string): void => {
  if (signal?.aborted) {
    throw new ApiError(409, `Client đã đóng kết nối cho step ${stepId}`, STEP_NOT_RUNNABLE)
  }
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

// ─── vòng S-5 theo màn (T18) ───────────────────────────────────────

/**
 * Hai step "sổ sách" của vòng S-5 KHÔNG gọi model dù registry để `deterministic: false`:
 * `S-5.1` chỉ dời con trỏ sang màn kế tiếp, `S-5.5` chỉ là cổng ký duyệt màn (gate đặt `signed_off`).
 * Trả tiền cho model để chọn phần tử đầu hàng đợi là lãng phí; đổi `deterministic` trong
 * `assets/step-registry.json` lại cần PR `contract-change` (đóng băng ở M2) — ghi ở `docs/spec-gaps.md`.
 */
export const LOOP_BOOKKEEPING_TEMPLATES: ReadonlySet<string> = new Set(["S-5.1", "S-5.5"])

/** Phases §6.2: một lượt Draft chỉ ôm tối đa 6 function — nhiều hơn thì model bỏ sót hoặc cắt giữa chừng. */
export const FUNCTION_BATCH_SIZE = 6

/** Step S-5.2 / S-5.4 viết chi tiết từng function ⇒ chia lô; S-5.1/S-5.3/S-5.5 thì không. */
const BATCHED_TEMPLATES: ReadonlySet<string> = new Set(["S-5.2", "S-5.4"])

const isLoopBookkeeping = (stepId: string): boolean => LOOP_BOOKKEEPING_TEMPLATES.has(getStep(stepId).template_id)

/**
 * `S-5.1`: đặt `progress.screen_cursor` sang màn của vòng này và chuyển màn sang `in_progress`. Vòng
 * `@nonscreen` (function không thuộc màn nào) đặt cursor về `null`. Màn đã `signed_off` giữ nguyên — quay
 * lại vòng cũ không hạ cấp nó. Màn `placeholder` thì CÓ chuyển (BUG-03): chạy S-5.1 của nó nghĩa là user
 * vừa mở lại màn bị để trống để mô tả tiếp.
 */
export const loopCursorOps = (spine: Spine, stepId: string): Op[] => {
  const step = getStep(stepId)
  if (step.template_id !== "S-5.1" || step.loop === null) return []

  if (step.loop === NONSCREEN_LOOP) {
    return spine.progress.screen_cursor === null ? [] : [{ op: "set", path: "progress.screen_cursor", value: null }]
  }

  const screen = spine.screens.find((s) => s.id === step.loop)
  if (!screen) return []
  const ops: Op[] = []
  if (spine.progress.screen_cursor !== screen.id) ops.push({ op: "set", path: "progress.screen_cursor", value: screen.id })
  if (screen.detail_status === "pending" || screen.detail_status === "placeholder") {
    ops.push({ op: "set", path: `screens[id=${screen.id}].detail_status`, value: "in_progress" })
  }
  return ops
}

/**
 * BUG-03: vòng S-5 của một màn `placeholder` bị `nextStep` bỏ qua, nên `S-5.1@<màn>` không bao giờ "tới
 * lượt" và panel Tiến độ khoá cứng 5 step của màn. Mở lại vòng là hành động hợp lệ của user: cho phép chạy
 * `S-5.1` của màn placeholder bất cứ lúc nào (các step sau của vòng tự tới lượt sau khi màn `in_progress`).
 */
export const isReopenableLoopStep = (spine: Spine, stepId: string): boolean => {
  const step = getStep(stepId)
  if (step.template_id !== "S-5.1" || step.loop === null || step.loop === NONSCREEN_LOOP) return false
  return spine.screens.some((s) => s.id === step.loop && s.detail_status === "placeholder")
}

/**
 * Step đã accepted nhưng section nó sở hữu đã **cũ** (`stale`/`awaiting_reaccept`): cho chạy lại.
 *
 * Cờ `section_stale_at_baseline` chặn ký baseline và chỉ đường về đúng step này, nhưng step đã accepted
 * thì `/run` trả STEP_NOT_RUNNABLE và cổng chốt đã đóng — user đi tới nơi rồi không làm được gì, chỉ còn
 * nước Waive một cờ đỏ. Làm mới lại nội dung mới là việc đúng, nên nó phải chạy được.
 */
export const isReopenableStaleStep = (spine: Spine, stepId: string, changes: Parameters<typeof computeSectionStates>[1]): boolean =>
  computeSectionStates(spine, changes).some(
    (state) => (state.status === "stale" || state.awaiting_reaccept) && ownerStepOf(state.id, spine) === stepId
  )

/** Màn `pending` đầu tiên của hàng đợi; hết ⇒ null (runner chuyển sang vòng `@nonscreen`). */
export const nextPendingScreen = (spine: Spine): string | null => {
  const byId = new Map(spine.screens.map((s) => [s.id, s]))
  return spine.progress.screen_queue.find((id) => byId.get(id)?.detail_status === "pending") ?? null
}

/** Function thuộc vòng hiện tại: theo màn, hoặc `screen_id === null` với vòng `@nonscreen`. */
const functionsOfLoop = (spine: Spine, loop: string): string[] =>
  spine.functions
    .filter((f) => (loop === NONSCREEN_LOOP ? f.screen_id === null : f.screen_id === loop))
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
    .map((f) => f.id)

/**
 * Chia function của vòng thành các lô ≤ `FUNCTION_BATCH_SIZE`. Step không chia lô (hoặc ít function)
 * trả một lô duy nhất `[]` — nghĩa là "dùng nguyên projection của step, không lọc".
 */
export const functionBatches = (spine: Spine, stepId: string): string[][] => {
  const step = getStep(stepId)
  if (!BATCHED_TEMPLATES.has(step.template_id) || step.loop === null) return [[]]
  const ids = functionsOfLoop(spine, step.loop)
  if (ids.length <= FUNCTION_BATCH_SIZE) return [[]]

  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += FUNCTION_BATCH_SIZE) batches.push(ids.slice(i, i + FUNCTION_BATCH_SIZE))
  return batches
}

/**
 * Context của một lô: giữ nguyên mọi thứ, chỉ thu hẹp phần `functions*` của projection về đúng lô.
 * Model chỉ thấy function trong lô nên chỉ phát op cho chúng — không cần thêm biến prompt mới
 * (`draft-to-ops.ts` là vùng của T11).
 */
export const batchContext = (ctx: StepContext, functionIds: readonly string[]): StepContext => {
  if (functionIds.length === 0) return ctx
  const keep = new Set(functionIds)
  const projection: Record<string, unknown> = {}
  for (const [selector, value] of Object.entries(ctx.projection)) {
    projection[selector] =
      selector.startsWith("functions") && Array.isArray(value)
        ? value.filter((el) => typeof el === "object" && el !== null && keep.has((el as { id?: string }).id ?? ""))
        : value
  }
  return { ...ctx, projection }
}

// ─── Draft + ghi Spine (dùng chung cho /run và gate regenerate/revision) ──

export interface DraftPhaseResult {
  spineVersion: number
  applied: boolean
  /** Tóm tắt đọc được của lô vừa ghi (WP-5) — gate gom lại thành "Bạn vừa có". */
  summary?: ChangeSummary[]
}

/**
 * Lỗi validate của model → một câu user hiểu được. Không bao giờ hiện mã (`path_not_resolved`,
 * `invariant_3_dead_reference`) ra ngoài; mã chỉ nằm trong phần "Chi tiết" của FE.
 */
export const retryReasonVi = (errors: readonly { rule: string }[]): string => {
  const rules = new Set(errors.map((e) => e.rule))
  if (rules.has("op_schema") || rules.has("schema_invalid")) return "kết quả thiếu trường hoặc sai kiểu dữ liệu"
  if (rules.has("op_out_of_scope")) return "AI định sửa phần ngoài phạm vi bước này"
  if (rules.has("duplicate_id")) return "AI đặt trùng mã của mục đã có"
  if (rules.has("path_not_resolved")) return "AI trỏ vào mục không tồn tại"
  if ([...rules].some((r) => r.startsWith("invariant_"))) return "kết quả vi phạm quy tắc liên kết của tài liệu"
  if (rules.has("path_not_writable")) return "AI định ghi vào phần không thuộc bước này"
  return "kết quả chưa hợp lệ"
}

/**
 * Chạy một lượt Draft (draft-to-ops T11) và ghi Spine (op engine T08). F2/F11: kiểm trần + ghi usage
 * `reserved` TRƯỚC khi gọi model, `finalizeCall`/`releaseCall` sau. 409 SPINE_VERSION_CONFLICT ⇒ hoàn
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
  assertNotAborted(deps.signal, stepId)
  const currentFirstSeq = spine.steps.find((s) => s.id === stepId)?.first_seq ?? null
  const { calls_used } = await meter.roundCounts(projectId, stepId, currentFirstSeq)
  if (calls_used >= CALLS_LIMIT) throw new ApiError(409, `Step ${stepId} đã dùng hết ${CALLS_LIMIT} lượt gọi model`, CALL_LIMIT)

  const reservedId = await meter.reserveCall(projectId, userId, stepId, callKind)
  let draftResult: Awaited<ReturnType<typeof draftOps>>
  try {
    draftResult = await draftOps(projectId, stepId, ctx, {
      userId,
      executor: deps.draftExecutor,
      spine,
      callKind,
      // Lượt thử lại phải nói ngay, bằng lời thường — user đang nhìn màn hình chờ (03 Lớp 3)
      onAttempt: ({ attempt, max, previousErrors }) => {
        if (attempt === 1 || previousErrors.length === 0) return
        emit({ type: "draft_retry", step_id: stepId, attempt, max, reason_vi: retryReasonVi(previousErrors) })
      },
      ...extra
    })
  } catch (err) {
    await meter.releaseCall(reservedId)
    throw err
  }

  const usageEntries = draftResult.usage.map((u) => ({
    call_kind: u.call_kind,
    attempt: u.attempt,
    tokens_in: u.tokens_in,
    tokens_out: u.tokens_out,
    cost: u.cost,
    logId: u.logId
  }))

  let usageIds: string[]
  if (usageEntries.length === 0) {
    await meter.releaseCall(reservedId)
    usageIds = []
  } else {
    const [first, ...rest] = usageEntries
    await meter.finalizeCall(reservedId, first)
    const restIds = rest.length > 0 ? await meter.recordUsage(projectId, userId, stepId, rest) : []
    usageIds = [reservedId, ...restIds]
  }

  for (const attempt of draftResult.attempts) emit({ type: "draft", step_id: stepId, attempt: attempt.attempt })

  if (!draftResult.txn) return { spineVersion: spine.spine_version, applied: false }

  try {
    const applied = await applyTransaction(projectId, draftResult.txn)
    const summary = summarizeChanges(applied.changes, stripRecord(applied.spine))
    emit({
      type: "ops_applied",
      step_id: stepId,
      txn: applied.txn ?? randomUUID(),
      spine_version: applied.spine_version,
      changes: applied.changes.map((c) => ({ op: c.op, path: c.path, before: c.before, value: c.value, reason: c.reason })),
      summary
    })
    return { spineVersion: applied.spine_version, applied: true, summary }
  } catch (err) {
    if (err instanceof ApiError && err.code === spineRepository.SPINE_VERSION_CONFLICT) {
      // 409 hai tab: model đã trả lời (credit đã deduct ở ví) nhưng Spine không ghi được — hoàn usage[]
      // (không tính vào trần) và hoàn credit về ví.
      await meter.refundUsage(usageIds)
    }
    throw err
  }
}

/** Render mọi diagram của step (nếu có) + Review (deterministic check; LLM review tuỳ `REVIEW_LLM_ENABLED`). */
/** Trần hình tự vẽ lại cuối một step — một step sửa nhiều thứ không được biến thành lượt render cả bộ. */
export const MAX_AUTO_RERENDER = 4

export interface RenderReviewOptions {
  /** Số cờ mở TRƯỚC khi chạy step — để gate nói "cờ đỏ 3 → 2 (−1)" thay vì chỉ một con số. */
  flagsBefore?: { red: number; yellow: number }
  /** Id giả định đã có trước step — phần còn lại là giả định MỚI, phải hiện ở gate (BUG-13). */
  knownAssumptionIds?: ReadonlySet<string>
  /**
   * Step này có ghi nội dung không. Chỉ khi CÓ mới vẽ lại các hình đã lạc hậu (BUG-17): một step chỉ đọc
   * mà tự đi vẽ lại hình của step khác thì vừa tốn thời gian, vừa biến lỗi render (vd PlantUML chết) thành
   * lỗi của step vô can.
   */
  rerenderStale?: boolean
}

export interface RenderReviewResult {
  spineVersion: number
  red_open: number
  yellow_open: number
  red_delta: number
  yellow_delta: number
  new_assumptions: { id: string; text: string }[]
}

export const runRenderReviewPhase = async (
  projectId: string,
  stepId: string,
  renders: readonly RenderTarget["kind"][],
  loop: string | null,
  userId: string,
  emit: Emit,
  deps: StepRunnerDeps,
  options: RenderReviewOptions = {}
): Promise<RenderReviewResult> => {
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

  // BUG-17: step này sửa dữ liệu nguồn của một hình đã vẽ ở step trước (vd S-5.4 sửa sau khi S-5.3 vẽ)
  // ⇒ vẽ lại ngay cuối step, thay vì để lại một cờ đỏ `diagram_stale` mà UI không có nút nào để gỡ.
  const { spine: spineAfterDraft } = await refresh(projectId)
  const alreadyRendered = new Set(renders)
  const staleTargets: RenderTarget[] = []
  for (const diagram of options.rerenderStale ? staleRenderedDiagrams(spineAfterDraft) : []) {
    if (alreadyRendered.has(diagram.kind)) continue
    const key = `${diagram.kind}:${diagram.owner_id ?? ""}`
    if (staleTargets.some((t) => `${t.kind}:${t.owner_id ?? ""}` === key)) continue
    staleTargets.push({ kind: diagram.kind, owner_id: diagram.owner_id })
  }
  if (staleTargets.length > 0) {
    const before = new Map(spineAfterDraft.diagrams.map((d) => [d.id, d]))
    const result = await renderDiagrams(projectId, staleTargets.slice(0, MAX_AUTO_RERENDER), { by: userId, step_id: stepId, ...(deps.renderDeps ? { deps: deps.renderDeps } : {}) })
    spineVersion = result.spine_version

    // Vẽ lại tự động mà hỏng (PlantUML chết, cú pháp lạ) thì KHÔNG để lại `render_error` — đó là cờ đỏ
    // không waive được, và nó sẽ chặn baseline vì một việc user không hề yêu cầu. Trả hình về bản cũ:
    // cờ `diagram_stale` (waive được) ở lại, kèm nút "Vẽ lại" để user tự quyết.
    const broken = result.diagrams.filter((d) => d.render_status === "error" && before.get(d.id)?.render_status === "ok")
    if (broken.length > 0) {
      const restored = await applyTransaction(projectId, {
        base_version: spineVersion,
        ops: broken.map((d) => ({ op: "set" as const, path: `diagrams[id=${d.id}]`, value: before.get(d.id) })),
        by: userId,
        step_id: stepId,
        reason: "step-runner: vẽ lại tự động thất bại, giữ hình cũ"
      })
      spineVersion = restored.spine_version
    }

    const brokenIds = new Set(broken.map((d) => d.id))
    for (const id of result.rendered) {
      if (brokenIds.has(id)) continue
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

  // Đang ở S-9 thì phải quét cả luật baseline: chạy lại một bước để làm mới section cũ mà cờ
  // `section_stale_at_baseline` không được đánh giá lại thì nó nằm đó mãi, dù nội dung đã mới.
  const { spine: spineBeforeCheck } = await refresh(projectId)
  const flagsResult = await flagsService.recompute(projectId, { by: userId, atBaseline: nextStepOf(spineBeforeCheck)?.phase === S9_PHASE })
  spineVersion = flagsResult.checked_at_version
  const redOpen = flagsResult.flags.filter((f) => f.level === "red" && f.resolved_at === null).length
  const yellowOpen = flagsResult.flags.filter((f) => f.level === "yellow" && f.resolved_at === null).length
  const { spine: spineAfterCheck } = await refresh(projectId)
  const newAssumptions = spineAfterCheck.assumptions
    .filter((a) => !options.knownAssumptionIds?.has(a.id))
    .map((a) => ({ id: a.id, text: a.statement }))
  emit({
    type: "flags",
    step_id: stepId,
    red_open: redOpen,
    yellow_open: yellowOpen,
    ...(options.flagsBefore ? { red_delta: redOpen - options.flagsBefore.red, yellow_delta: yellowOpen - options.flagsBefore.yellow } : {}),
    ...(options.knownAssumptionIds ? { new_assumptions: newAssumptions } : {})
  })

  // Lớp phủ LLM review — tắt mặc định (đọc process.env trực tiếp, không qua src/config theo yêu cầu task).
  // F2/F11: kiểm trần + reserve trước khi gọi, như elicit/draft. Lớp phủ không chặn step: lỗi/hết trần chỉ log.
  if (env.REVIEW_LLM_ENABLED && !deps.signal?.aborted) {
    const { spine: spineForReview } = await refresh(projectId)
    const currentFirstSeq = spineForReview.steps.find((s) => s.id === stepId)?.first_seq ?? null
    const { calls_used } = await meter.roundCounts(projectId, stepId, currentFirstSeq)
    if (calls_used >= CALLS_LIMIT) {
      console.error(`[step-runner] LLM review bị bỏ qua cho ${stepId}: đã hết ${CALLS_LIMIT} lượt gọi model`)
    } else {
      const reservedId = await meter.reserveCall(projectId, userId, stepId, "review")
      try {
        const spine = spineForReview
        const spec = getStepSpec(stepId)
        const result = await deps.reviewExecutor(
          { promptVariables: { step_id: stepId, step_name: spec.label_en, working_mode: spine.project.working_mode ?? "coaching" } },
          projectId,
          userId
        )
        await meter.finalizeCall(reservedId, {
          call_kind: "review",
          attempt: 1,
          tokens_in: result.tokensUsed.promptTokens,
          tokens_out: result.tokensUsed.completionTokens,
          cost: result.cost,
          logId: result.logId || null
        })
      } catch (err) {
        // Review LLM là lớp phủ thêm, không chặn step — lỗi chỉ log.
        await meter.releaseCall(reservedId)
        console.error(`[step-runner] LLM review thất bại cho ${stepId}:`, err)
      }
    }
  }

  return {
    spineVersion,
    red_open: redOpen,
    yellow_open: yellowOpen,
    red_delta: redOpen - (options.flagsBefore?.red ?? redOpen),
    yellow_delta: yellowOpen - (options.flagsBefore?.yellow ?? yellowOpen),
    new_assumptions: newAssumptions
  }
}

/** Ghi lại `steps[id].first_seq/last_seq` theo dải change thực tế đã ghi kể từ `startSeq`. */
export const trackSeqRange = async (
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

/** F15: session không tồn tại/không thuộc project là cùng một lớp lỗi với "không phải session pipeline"
 *  (client không được suy ra Spine có tồn tại hay không từ mã lỗi) — cả hai đều 403 NOT_PIPELINE_SESSION. */
export const requirePipelineSession = async (projectId: string, sessionId: string): Promise<void> => {
  const session = await ChatSession.findById(sessionId)
  if (!session || String(session.projectId) !== String(projectId) || !session.is_pipeline) {
    throw new ApiError(403, "Session này không phải session pipeline của dự án — chỉ dùng để hỏi đáp (CHAT)", NOT_PIPELINE_SESSION)
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
  emitRaw: Emit,
  deps: Partial<StepRunnerDeps> = {}
): Promise<void> => {
  // WP-4: khoá nằm ở Mongo, có TTL + heartbeat. Lượt cũ mất SSE ⇒ khoá tự hết hạn, không còn cảnh chờ 20 phút.
  const run = await acquireRun(projectId, stepId, { sessionId, by: userId, stage: "intake", detail_vi: STAGE_LABELS.intake })
  if (deps.abort) registerAbort(run.run_id, deps.abort)
  const tracker = createTracker(projectId, stepId, run.run_id, emitRaw)
  const emit = tracker.emit
  let outcome: "gate" | "interrupted" = "interrupted"
  let lastError: { code: string; message: string } | null = null

  try {
    const d: StepRunnerDeps = { ...defaultStepRunnerDeps(deps.signal), ...deps }

    await requirePipelineSession(projectId, sessionId)
    const stepDef = getStep(stepId) // 404 STEP_NOT_FOUND nếu id sai
    const spec = getStepSpec(stepId)
    const needsDraft = spec.skill !== null && !stepDef.deterministic && !isLoopBookkeeping(stepId)

    let { spine, spineVersion } = await refresh(projectId)
    const existingStep = spine.steps.find((s) => s.id === stepId)

    if (existingStep?.status === "skipped") {
      throw new ApiError(409, `Step ${stepId} không áp dụng cho template của dự án — bật lại ở kế hoạch step trước khi chạy`, STEP_NOT_RUNNABLE)
    }
    // BUG-03: S-5.1 của màn placeholder chạy lại được ngay (kể cả đã accepted bằng accept_as_is "để sau") —
    // đó chính là cách user mở lại một màn đã bị bỏ qua.
    const reopenLoop =
      isReopenableLoopStep(spine, stepId) ||
      (existingStep?.status === "accepted" && isReopenableStaleStep(spine, stepId, await spineRepository.listChanges(projectId)))
    if (existingStep?.status === "accepted" && !reopenLoop) {
      throw new ApiError(409, `Step ${stepId} đã accepted — cần gate revision/regenerate để mở lại (B7)`, STEP_NOT_RUNNABLE)
    }
    if (!existingStep && !reopenLoop) {
      const next = nextStepOf(spine)
      if (!next || next.id !== stepId) throw new ApiError(409, `Step ${stepId} chưa tới lượt chạy`, STEP_NOT_RUNNABLE)
    }

    if (needsDraft) {
      const { calls_used } = await usageCounts(projectId, stepId, existingStep?.first_seq ?? null)
      if (calls_used >= CALLS_LIMIT) throw new ApiError(409, `Step ${stepId} đã dùng hết ${CALLS_LIMIT} lượt gọi model`, CALL_LIMIT)
    }

    // ─── init: cập nhật progress cursor + đặt step in_progress (B7: reset vòng khi reopen sau accepted) ──
    const phaseChanged = spine.progress.current_phase !== stepDef.phase
    const reopenedAfterAccept =
      (existingStep?.status === "revision_requested" && existingStep.accepted_at !== null) || (existingStep?.status === "accepted" && reopenLoop)

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
      ;({ spine, spineVersion } = await refresh(projectId))
    }

    // T18 — S-5.1: dời con trỏ vòng lặp sang màn của vòng này. Ghi TRƯỚC `startSeq` như init ops: đây là
    // sổ sách của vòng, không phải nội dung do step sinh ra (resume revert dải nội dung không được xoá nó).
    const cursorOps = loopCursorOps(spine, stepId)
    if (cursorOps.length > 0) {
      const applied = await applyTransaction(projectId, { base_version: spineVersion, ops: cursorOps, by: userId, step_id: stepId, reason: "step-runner: con trỏ vòng S-5" })
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
    tracker.stage("intake", { detail_vi: `Đọc dữ liệu cho bước ${stepId}` })

    // Mốc để gate nói được "cờ đỏ 3 → 2" và "3 giả định mới" (WP-5, BUG-13)
    const flagsBefore = {
      red: spine.flags.filter((f) => f.level === "red" && f.resolved_at === null).length,
      yellow: spine.flags.filter((f) => f.level === "yellow" && f.resolved_at === null).length
    }
    const knownAssumptionIds = new Set(spine.assumptions.map((a) => a.id))
    const progressBefore = buildProgressReport(spine, await spineRepository.listChanges(projectId)).readiness.accepted_pct
    const stepSummary: ChangeSummary[] = []

    /**
     * Câu trả lời đưa vào lượt soạn. Ngoài transcript của chính bước, LUÔN kèm sổ quyết định: khi câu hỏi
     * được hỏi gộp ở đầu giai đoạn (R3), transcript của bước này rỗng — không kèm sổ thì model soạn mà
     * không biết user đã trả lời gì, và bước ghi ra 0 op.
     */
    const ledger = ledgerForPrompt(spine)
    const ledgerText = ledger.length === 0 ? "" : ["Đã chốt với user:", ...ledger.map((d) => `- ${d.topic_key}: ${d.answer}`)].join("\n")
    let answersText = [ledgerText, ctx.transcriptTail].filter((part) => part.trim() !== "").join("\n")

    // T19 — pha S-9: việc của từng step nằm ở `s9/run-s9-step.ts`, không đi qua STEP_SKILLS.
    // S-9.1/S-9.5 không gọi model và không Meter (hết credit vẫn quét và vẫn ký baseline được).
    if (stepDef.phase === S9_PHASE) {
      if (!S9_FREE_STEPS.has(parseStepId(stepId).base)) {
        assertNotAborted(d.signal, stepId)
        emit({ type: "draft", step_id: stepId, attempt: 1 })
      }
      tracker.stage("draft", { detail_vi: "Quét cuối và xếp ưu tiên" })
      await tracker.beat("draft", () => runS9Step(projectId, stepId, userId, { draftExecutor: d.draftExecutor, reviewExecutor: d.reviewExecutor, sessionId }))
      ;({ spine, spineVersion } = await refresh(projectId))
      // Pha S-9 ghi thẳng qua service riêng (không qua runDraftPhase) — vẫn phải tóm tắt được ở gate,
      // nếu không thì S-9.4 xếp lại ưu tiên cả tài liệu mà gate hiện đúng một dòng trống (BUG-20).
      const s9Changes = (await spineRepository.listChanges(projectId, { fromSeq: startSeq })).filter((c) => c.step_id === stepId)
      stepSummary.push(...summarizeChanges(s9Changes, spine))
    }

    if (needsDraft) {
      const workingMode = spine.project.working_mode ?? "coaching"
      const shouldElicit = !d.skipElicit && (workingMode === "coaching" || spine.progress.elicit_turns_this_phase < 2)

      if (shouldElicit) {
        assertNotAborted(d.signal, stepId)
        tracker.stage("ask", { detail_vi: "Xem bước này còn thiếu gì để hỏi bạn" })
        const { calls_used: callsBeforeElicit } = await meter.roundCounts(projectId, stepId, stepStateForRound?.first_seq ?? null)
        if (callsBeforeElicit >= CALLS_LIMIT) throw new ApiError(409, `Step ${stepId} đã dùng hết ${CALLS_LIMIT} lượt gọi model`, CALL_LIMIT)

        const elicitUsageId = await meter.reserveCall(projectId, userId, stepId, "elicit")
        let elicitResult: AiActionResult<ElicitOutput>
        try {
          elicitResult = await tracker.beat("ask", () =>
            d.elicitExecutor(
            {
              promptVariables: {
                step_id: stepId,
                step_name: ctx.label_en,
                working_mode: workingMode,
                elicit_turns_this_phase: spine.progress.elicit_turns_this_phase,
                missing: ctx.emptyFields,
                // BUG-19: vòng hỏi phải thấy quy tắc và NFR đã chốt, nếu không nó gợi ý ngược lại chính
                // câu trả lời của user ở bước trước.
                projection: elicitProjection(spine, stepId),
                addendum: ctx.addendum,
                // BUG-10: guidance của content skill từng bị bỏ trống ⇒ B-0.1 không hỏi tên hệ thống
                content_guidance: elicitGuidance(ctx),
                // R4: sổ quyết định — "đã chốt gì, ở bước nào"
                decisions: ledgerForPrompt(spine),
                recent_turns: ctx.transcriptTail,
                user_message: "(tự động — vòng elicit đầu step)"
              }
            },
              projectId,
              userId
            )
          )
        } catch (err) {
          await meter.releaseCall(elicitUsageId)
          throw err
        }
        await meter.finalizeCall(elicitUsageId, {
          call_kind: "elicit",
          attempt: 1,
          tokens_in: elicitResult.tokensUsed.promptTokens,
          tokens_out: elicitResult.tokensUsed.completionTokens,
          cost: elicitResult.cost,
          logId: elicitResult.logId || null
        })
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

        // R4: bỏ câu thuộc chủ đề đã chốt — luật của server, không chỉ là lời nhắc trong prompt (BUG-21)
        const filtered = filterAskedQuestions(spine, elicitResult.data.questions)
        if (filtered.dropped.length > 0) {
          console.info(`[step-runner] ${stepId}: bỏ ${filtered.dropped.length} câu đã chốt (${filtered.dropped.map((d) => d.topic_key).join(", ")})`)
        }

        if (filtered.questions.length > 0) {
          const asked = filtered.questions
          const questions = asked.map((q, i) => {
            const options = sanitizeSuggestions(q.topic_key, q.suggestedAnswers)
            return {
              id: `Q${i + 1}`,
              text: q.question,
              ...(options.length > 0 ? { options } : {}),
              ...(q.multiple !== undefined ? { multiple: q.multiple } : {})
            }
          })
          emit({ type: "answer_needed", step_id: stepId, questions })
          // Chờ user: ghi câu hỏi vào run-state để reload dựng lại đúng form (BUG-07)
          await tracker.save({ status: "waiting_answer", stage: "ask", detail_vi: `Chờ bạn trả lời ${questions.length} câu`, questions })
          const answers = await waitForAnswer(projectId, stepId, sessionId, d.signal)
          // Phản hồi ngay khi nhận trả lời — trước đây status đứng yên tới 2 phút (BUG-32)
          emit({ type: "answer_received", step_id: stepId, count: answers.length })
          await tracker.save({ status: "running", questions: null, detail_vi: `Đã nhận ${answers.length} câu trả lời` })
          const answersJoined = answers.map((a) => `${a.question_id}: ${Array.isArray(a.answer) ? a.answer.join(", ") : a.answer}`).join("\n")
          for (const a of answers) await pushTranscript(sessionId, stepId, "user", Array.isArray(a.answer) ? a.answer.join(", ") : a.answer)
          answersText = `${answersText}\n${answersJoined}`.trim()

          // R4: ghi câu trả lời vào sổ quyết định để không step nào hỏi lại chủ đề này nữa
          const answeredTopics: AnsweredTopic[] = answers.flatMap((a) => {
            const index = Number(/^Q(\d+)$/.exec(a.question_id)?.[1] ?? 0) - 1
            const question = asked[index]
            if (!question) return []
            return [{ topic_key: question.topic_key, question: question.question, answer: Array.isArray(a.answer) ? a.answer.join(", ") : a.answer }]
          })
          const ledgerOps = decisionOps(spine, stepId, answeredTopics)
          if (ledgerOps.length > 0) {
            const ledgerApplied = await applyTransaction(projectId, {
              base_version: spineVersion,
              ops: ledgerOps,
              by: userId,
              step_id: stepId,
              reason: "step-runner: ghi quyết định đã chốt"
            })
            spineVersion = ledgerApplied.spine_version
          }
        }
        ;({ spine, spineVersion } = await refresh(projectId))
      }

      // T18 — S-5.2/S-5.4: màn nhiều function chia thành nhiều lượt Draft ≤ 6 function. Mỗi lượt vẫn
      // tự kiểm trần 8 lượt gọi/step trong `runDraftPhase`; màn quá lớn sẽ dừng ở CALL_LIMIT và user
      // chốt phần đã có ở gate (không có ngoại lệ trần cho vòng lặp).
      const batches = functionBatches(spine, stepId)
      for (const [index, batch] of batches.entries()) {
        const current = await refresh(projectId)
        spine = current.spine
        spineVersion = current.spineVersion
        const batchInfo = batches.length > 1 ? { i: index + 1, n: batches.length } : undefined
        tracker.stage("draft", {
          detail_vi: batchInfo ? `AI đang soạn nội dung · lô ${batchInfo.i}/${batchInfo.n}` : "AI đang soạn nội dung",
          ...(batchInfo ? { batch: batchInfo } : {})
        })
        const draftPhase = await tracker.beat("draft", () =>
          runDraftPhase(projectId, stepId, batchContext(ctx, batch), spine, userId, "draft", emit, d, { answers: answersText })
        )
        spineVersion = draftPhase.spineVersion
        stepSummary.push(...(draftPhase.summary ?? []))
      }
    }

    tracker.stage("check", { detail_vi: "Kiểm tra quy tắc và tham chiếu" })
    if (stepDef.renders.length > 0) tracker.stage("render", { detail_vi: `Vẽ lại ${stepDef.renders.length} sơ đồ` })
    const review = await tracker.beat(stepDef.renders.length > 0 ? "render" : "check", () =>
      runRenderReviewPhase(projectId, stepId, stepDef.renders, parseStepId(stepId).loop, userId, emit, d, {
        flagsBefore,
        knownAssumptionIds,
        rerenderStale: stepSummary.length > 0
      })
    )
    spineVersion = review.spineVersion
    await trackSeqRange(projectId, spineVersion, stepId, userId, startSeq, stepStateForRound)

    // Ghép SAU khi cờ đã tính lại và dải seq đã ghi — cache khớp đúng spine_version user nhìn ở gate.
    if (stepDef.template_id === ASSEMBLE_STEP) {
      assertNotAborted(d.signal, stepId)
      await d.assembleDocument(projectId, (await refresh(projectId)).spineVersion)
    }

    const { spine: finalSpine } = await refresh(projectId)
    const finalFirstSeq = finalSpine.steps.find((s) => s.id === stepId)?.first_seq ?? null
    const { calls_used, regenerate_used } = await usageCounts(projectId, stepId, finalFirstSeq)
    const actions: GateAction[] = regenerate_used >= REGENERATE_LIMIT_COUNT ? ["accept", "revision", "accept_as_is"] : ["accept", "revision", "regenerate"]
    const creditsUsed = await meter.roundCost(projectId, stepId, finalFirstSeq)
    const progressAfter = buildProgressReport(finalSpine, await spineRepository.listChanges(projectId)).readiness.accepted_pct

    // Lớp 4 "Bạn vừa có" (03) + WP-5: gate mang nội dung, không chỉ con số
    const gateEvent: StepEvent = {
      type: "gate_ready",
      step_id: stepId,
      actions,
      regenerate_used,
      calls_used,
      summary: stepSummary,
      new_assumptions: review.new_assumptions,
      flags: { red: review.red_open, yellow: review.yellow_open, red_delta: review.red_delta, yellow_delta: review.yellow_delta },
      duration_ms: Date.now() - tracker.startedAt,
      credits_used: creditsUsed,
      ...(gateTableOf(finalSpine, stepDef.template_id) ? { table: gateTableOf(finalSpine, stepDef.template_id) as NonNullable<ReturnType<typeof gateTableOf>> } : {}),
      doc_progress: { before: progressBefore, after: progressAfter },
      ...(stepSummary.length === 0 ? { no_change_reason: noChangeReason(stepDef.template_id, needsDraft) } : {})
    }
    tracker.stage("gate", { detail_vi: STAGE_LABELS.gate })
    emit(gateEvent)
    outcome = "gate"
    await tracker.save({ status: "gate", stage: "gate", gate_payload: gateEvent, questions: null })
  } catch (err) {
    lastError = { code: err instanceof ApiError ? err.code : "UNKNOWN", message: err instanceof Error ? err.message : String(err) }
    throw err
  } finally {
    if (outcome === "gate") {
      // Khoá nhả ngay khi tới gate: user có thể huỷ/chạy lại mà không phải chờ TTL
      await finishRun(projectId, stepId, run.run_id, "gate")
    } else {
      await finishRun(projectId, stepId, run.run_id, "interrupted", { error: lastError })
    }
    unregisterAbort(run.run_id)
  }
}

/**
 * BUG-10: `content_guidance` của vòng hỏi trước đây là chuỗi rỗng, nên B-0.1 không hề biết nó phải hỏi
 * tên hệ thống — 5 vòng elicit trôi qua mà `system_name` vẫn null. Dùng đúng skill content của step.
 */
export const elicitGuidance = (ctx: StepContext): string => {
  if (!ctx.skill) return ""
  const skill = getSkill(ctx.skill)
  return skill.stub ? "" : skill.template
}

/** Step không ghi gì thì gate phải nói VÌ SAO (03 Lớp 4) — im lặng là thứ làm user mất tin. */
export const noChangeReason = (templateId: string, needsDraft: boolean): string => {
  if (LOOP_BOOKKEEPING_TEMPLATES.has(templateId)) return "Bước sổ sách của vòng màn hình — không có nội dung để ghi."
  if (!needsDraft) return "Bước tất định — chỉ kiểm tra lại, không sinh nội dung mới."
  return "AI không tìm thấy gì cần thêm hoặc sửa ở bước này."
}

/** Mã lỗi pipeline hợp lệ — controller dùng để quyết định phát SSE `error` hay để nguyên lỗi HTTP thường. */
export const isPipelineErrorCode = (code: string): code is PipelineErrorCode => code in PIPELINE_ERROR_STATUS
