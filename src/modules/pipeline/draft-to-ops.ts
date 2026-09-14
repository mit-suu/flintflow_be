/**
 * draft-to-ops.ts
 * ─────────────────────────────────────────────────────────────────
 * Cầu nối model → op engine (Phases §2.1, §4.1): gọi skill `draft-to-ops` kèm skill content của step,
 * parse `opTransactionSchema`, `validateOps` trên Spine hiện tại; sai thì gửi lại kèm lỗi tối đa 2 lần,
 * hết lượt thì 422 `NEEDS_USER_INPUT` (UC 6.11 hỏi user).
 *
 * KHÔNG ghi Spine: trả `Transaction` cho step runner (T13) gọi `applyTransaction`.
 * Raw text của model không bao giờ đi tiếp — parse lỗi chỉ thành thông báo cho lượt retry.
 */

import { randomUUID } from "node:crypto"
import * as repository from "../spine/spine.repository.js"
import type { Op, Transaction } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { ActionType, AiActionError, type AiActionInput, type AiActionResult } from "../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { getSkill } from "../../shared/ai/prompt-registry.service.js"
import type { OpTransaction } from "../../shared/ai/response-parser.js"
import type { StepContext } from "./context-projection.js"
import { validateOps, type ValidationError } from "./op-validator.js"

export const NEEDS_USER_INPUT = "NEEDS_USER_INPUT"
/** Phases §4.1: gửi lại model kèm lỗi tối đa 2 lần, rồi hỏi user. */
export const MAX_SCHEMA_RETRIES = 2

export type DraftCallKind = "draft" | "regenerate" | "revision" | "glossary_scan"

const ACTION_BY_CALL_KIND: Readonly<Record<DraftCallKind, ActionType>> = {
  draft: ActionType.DRAFT,
  regenerate: ActionType.REGENERATE,
  revision: ActionType.REVISION,
  glossary_scan: ActionType.GLOSSARY_SCAN
}

export type DraftExecutor = (
  actionType: ActionType,
  input: AiActionInput,
  projectId: string,
  userId: string
) => Promise<AiActionResult<OpTransaction>>

export interface DraftUsage {
  attempt: number
  call_kind: DraftCallKind
  tokens_in: number
  tokens_out: number
  cost: number
  logId: string | null
}

export interface DraftAttempt {
  attempt: number
  ops: unknown[]
  errors: ValidationError[]
}

export interface DraftResult {
  /** null ⇒ model trả `ops: []` hợp lệ: step không cần đổi Spine (lý do trong `notes`). Không có gì để áp. */
  txn: Transaction | null
  attempts: DraftAttempt[]
  usage: DraftUsage[]
  notes: string | null
  contextTokens: number
}

export interface DraftOptions {
  userId: string
  callKind?: DraftCallKind
  maxSchemaRetries?: number
  /** Câu trả lời Elicit; mặc định `ctx.transcriptTail`. */
  answers?: string
  revisionRequest?: string
  /** Spine để validate; mặc định đọc repository (phải cùng `spine_version` với ctx). */
  spine?: Spine
  executor?: DraftExecutor
}

/** 422 sau khi hết lượt retry — `errors` và `lastOps` để UI hỏi user (không ghi gì vào Spine). */
export class DraftRejectedError extends ApiError {
  readonly errors: ValidationError[]
  readonly lastOps: unknown[]
  readonly attempts: DraftAttempt[]

  constructor(attempts: DraftAttempt[]) {
    const last = attempts[attempts.length - 1]
    super(422, `Model không tạo được lô op hợp lệ sau ${attempts.length} lượt: ${last?.errors[0]?.message ?? "không rõ"}`, NEEDS_USER_INPUT)
    this.errors = last?.errors ?? []
    this.lastOps = last?.ops ?? []
    this.attempts = attempts
  }
}

const SCHEMA_ERROR_CODES = new Set(["PARSE_FAILED", "SCHEMA_MISMATCH"])

const defaultExecutor: DraftExecutor = (actionType, input, projectId, userId) =>
  executeAiAction<OpTransaction>(actionType, input, projectId, userId)

const contentGuidance = (ctx: StepContext): string => {
  if (!ctx.skill) return ""
  const skill = getSkill(ctx.skill)
  return skill.stub ? `Content skill ${ctx.skill} is not written yet; follow the generic rules.` : skill.template
}

const loadSpine = async (projectId: string, expectedVersion: number): Promise<Spine> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  if (record.spine_version !== expectedVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", repository.SPINE_VERSION_CONFLICT)
  }
  const { projectId: _projectId, ...spine } = record
  return spine
}

export const draftOps = async (projectId: string, stepId: string, ctx: StepContext, options: DraftOptions): Promise<DraftResult> => {
  const callKind = options.callKind ?? "draft"
  const maxRetries = options.maxSchemaRetries ?? MAX_SCHEMA_RETRIES
  const executor = options.executor ?? defaultExecutor
  const spine = options.spine ?? (await loadSpine(projectId, ctx.spine_version))

  const guidance = contentGuidance(ctx)
  const attempts: DraftAttempt[] = []
  const usage: DraftUsage[] = []
  let errors: ValidationError[] = []
  // Lượt retry cần thấy chính lô op đã sai, không chỉ danh sách lỗi (op_index trỏ vào lô này)
  let previousOps: unknown[] | null = null

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const promptVariables = {
      step_id: stepId,
      step_name: ctx.label_en,
      call_kind: callKind,
      writable_paths: ctx.writable.join(", "),
      working_mode: ctx.working_mode ?? "coaching",
      projection: ctx.projection,
      addendum: ctx.addendum,
      answers: options.answers ?? (ctx.transcriptTail || "(none)"),
      revision_request: options.revisionRequest ?? "(none)",
      content_guidance: ctx.documents ? `${guidance}\n\n${ctx.documents}` : guidance,
      validation_errors: errors.length > 0 ? errors : "(none)",
      previous_ops: previousOps ?? "(none)"
    }

    let ops: unknown[] = []
    let notes: string | null = null
    try {
      const result = await executor(ACTION_BY_CALL_KIND[callKind], { promptVariables }, projectId, options.userId)
      usage.push({
        attempt,
        call_kind: callKind,
        tokens_in: result.tokensUsed.promptTokens,
        tokens_out: result.tokensUsed.completionTokens,
        cost: result.cost,
        logId: result.logId || null
      })
      ops = result.data.ops
      notes = result.data.notes ?? null
      errors = validateOps(spine, ops, { writable: ctx.writable, stepId })

      if (errors.length === 0) {
        attempts.push({ attempt, ops, errors })
        if (ops.length === 0) return { txn: null, attempts, usage, notes, contextTokens: ctx.contextTokens }
        const txn: Transaction = {
          // Id lô luôn do server sinh — không tin `txn` model trả (có thể trùng lô khác)
          txn: randomUUID(),
          base_version: spine.spine_version,
          ops: ops as Op[],
          by: options.userId,
          step_id: stepId
        }
        return { txn, attempts, usage, notes, contextTokens: ctx.contextTokens }
      }
    } catch (err) {
      if (!(err instanceof AiActionError) || !SCHEMA_ERROR_CODES.has(err.code)) throw err
      errors = [{ rule: "schema_invalid", message: `Output không đúng opTransaction: ${err.message}` }]
    }
    attempts.push({ attempt, ops, errors })
    previousOps = ops
  }

  throw new DraftRejectedError(attempts)
}
