/**
 * pipeline.dto.ts
 * ─────────────────────────────────────────────────────────────────
 * Zod request/response cho Pipeline API — HỢP ĐỒNG ĐÓNG BĂNG tại M2.
 * Tài liệu đi kèm: `docs/api/pipeline-contract.md`. Đổi file này ⇒ PR `contract-change`.
 *
 * Mọi response bọc trong envelope chung `{ data, meta?, error }` (shared/types/api-response.ts).
 * Lỗi: `error = { code, message }`; 422 từ op engine có thêm `meta = { violations, referrers }`.
 *
 * Kiểu section status / progress / flags do T09 hiện thực; kiểu step do T12/T13;
 * document do T15 (`RenderedDocument`, T05). Ở đây chỉ chốt HÌNH của dữ liệu trên dây.
 */

import { z } from "zod"
import {
  baselineSchema,
  changeSchema,
  flagSchema,
  spineRecordSchema,
  WAIVE_REASON_MIN_LENGTH
} from "../spine/spine.schema.js"
import { opSchema, userOpSchema } from "../spine/op.types.js"

// ─── mã lỗi ──────────────────────────────────────────────────────

/** Mã lỗi pipeline và HTTP status tương ứng. */
export const PIPELINE_ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  FLAG_NOT_WAIVABLE: 400,
  UNAUTHORIZED: 401,
  INSUFFICIENT_CREDIT: 402,
  NOT_PIPELINE_SESSION: 403,
  PROJECT_NOT_FOUND: 404,
  SPINE_NOT_FOUND: 404,
  STEP_NOT_FOUND: 404,
  FLAG_NOT_FOUND: 404,
  BASELINE_NOT_FOUND: 404,
  DIAGRAM_NOT_FOUND: 404,
  SPINE_VERSION_CONFLICT: 409,
  NEEDS_USER_INPUT: 409,
  NEEDS_CLARIFICATION: 409,
  REGENERATE_LIMIT: 409,
  CALL_LIMIT: 409,
  STEP_NOT_RUNNABLE: 409,
  NO_WORKING_DRAFT: 409,
  INVARIANT_VIOLATION: 422,
  OP_INVALID: 422,
  CHANGE_RANGE_INVALID: 422,
  NOTHING_TO_UNDO: 422,
  BASELINE_BLOCKED: 422,
  /** Nhà cung cấp AI từ chối: hết hạn mức, chưa có phương thức thanh toán, hoặc gọi quá nhanh. */
  RATE_LIMIT_EXCEEDED: 429,
  /** Nhà cung cấp AI lỗi / trả rỗng (GLM_EMPTY_OUTPUT, 5xx…) — không phải lỗi logic của pipeline. */
  AI_PROVIDER_ERROR: 502,
  NOT_IMPLEMENTED: 501
} as const

export type PipelineErrorCode = keyof typeof PIPELINE_ERROR_STATUS

export const pipelineErrorCodeSchema = z.enum(
  Object.keys(PIPELINE_ERROR_STATUS) as [PipelineErrorCode, ...PipelineErrorCode[]]
)

// ─── envelope ────────────────────────────────────────────────────

export const apiErrorSchema = z.object({ code: z.string().min(1), message: z.string() })

export const envelope = <T extends z.ZodType>(data: T) =>
  z.object({
    data: data.nullable(),
    meta: z.record(z.string(), z.unknown()).optional(),
    error: apiErrorSchema.nullable()
  })

export const violationSchema = z.object({
  rule: z.string().min(1),
  message: z.string(),
  path: z.string().optional(),
  op_index: z.number().int().min(0).optional()
})

export const referrerSchema = z.object({ path: z.string().min(1), id: z.string().min(1) })

/** `meta` của lỗi 422 INVARIANT_VIOLATION / OP_INVALID. */
export const transactionRejectedMetaSchema = z.object({
  violations: z.array(violationSchema),
  referrers: z.array(referrerSchema)
})

const baseVersion = z.number().int().min(1)
const isoDateTime = z.iso.datetime({ offset: true })

// ─── spine / changes ─────────────────────────────────────────────

/** GET /projects/:id/spine */
export const getSpineResponseSchema = spineRecordSchema

/** POST /projects/:id/changes và /changes/preview — `ops` thuần (T08) hoặc `instruction` (T17). */
export const changesRequestSchema = z
  .strictObject({
    base_version: baseVersion,
    ops: z.array(userOpSchema).min(1).optional(),
    instruction: z.string().trim().min(1).optional(),
    /** Bắt buộc sau khi đã có baseline (UC 6.8, T17). */
    reason: z.string().trim().min(1).optional(),
    /** Chỉ `/changes` với `instruction`: id preview đã được user xác nhận (T17). */
    preview_id: z.string().min(1).optional()
  })
  .refine((v) => (v.ops === undefined) !== (v.instruction === undefined), {
    message: "Cần đúng một trong hai: ops hoặc instruction"
  })

export type ChangesRequest = z.infer<typeof changesRequestSchema>

const changeDiffSchema = z.object({
  op: z.string().min(1),
  path: z.string().min(1),
  before: z.unknown(),
  value: z.unknown(),
  reason: z.string().nullable()
})

export const impactSchema = z.object({
  fields: z.array(z.string()),
  sections: z.array(z.object({ id: z.string(), relation: z.enum(["owner", "reads", "derived"]) })),
  diagrams: z.array(z.string()),
  referrers: z.array(referrerSchema)
})

/** POST /projects/:id/changes/preview — 200 kể cả khi bị từ chối (`ok=false`). */
export const changesPreviewResponseSchema = z.object({
  ok: z.boolean(),
  txn: z.string().min(1),
  base_version: baseVersion,
  ops: z.array(opSchema),
  changes: z.array(changeDiffSchema),
  violations: z.array(violationSchema),
  referrers: z.array(referrerSchema),
  /** T17: nhánh xử lý và phạm vi ảnh hưởng. */
  branch: z.enum(["silent", "dependent", "post_baseline"]).optional(),
  impact: impactSchema.optional(),
  /** T17: lệnh mơ hồ (UC 6.11) — không có ops. */
  clarification: z.string().optional(),
  preview_id: z.string().optional()
})

/** POST /projects/:id/changes, /undo, /reconcile — kết quả một transaction đã ghi. */
export const applyResultResponseSchema = z.object({
  /** null ⇒ lô không đổi gì: không ghi change, `spine_version` giữ nguyên. */
  txn: z.string().min(1).nullable(),
  spine_version: baseVersion,
  changes: z.array(changeSchema),
  spine: spineRecordSchema
})

/** POST /projects/:id/undo */
export const undoRequestSchema = z.strictObject({ base_version: baseVersion })

/** POST /projects/:id/reconcile — lượt 1 trả preview gộp, lượt 2 gửi `preview_id` để áp. */
export const reconcileRequestSchema = z.strictObject({
  base_version: baseVersion,
  preview_id: z.string().min(1).optional()
})

/** GET /projects/:id/changes?from&to (seq, bao gồm hai đầu) */
export const changesQuerySchema = z.object({
  from: z.coerce.number().int().min(1).optional(),
  to: z.coerce.number().int().min(1).optional()
})

export const changesListResponseSchema = z.array(changeSchema)

// ─── steps ───────────────────────────────────────────────────────

export const stepKindSchema = z.enum(["soft", "fixed", "loop", "gate"])
export const gateActionSchema = z.enum(["accept", "revision", "regenerate", "accept_as_is"])

export const stepSummarySchema = z.object({
  id: z.string().min(1),
  phase: z.string().min(1),
  label_vi: z.string(),
  label_en: z.string(),
  kind: stepKindSchema,
  status: z.enum(["pending", "in_progress", "accepted", "revision_requested"]),
  deterministic: z.boolean(),
  calls_used: z.number().int().min(0),
  calls_limit: z.literal(8),
  regenerate_used: z.number().int().min(0),
  regenerate_limit: z.literal(3),
  accepted_at: isoDateTime.nullable(),
  /** Step đang chạy dở ở một request khác (cùng tiến trình BE) — FE khoá nút chạy thay vì để người dùng bấm rồi nhận 409. */
  running: z.boolean()
})

/** GET /projects/:id/steps */
export const stepsResponseSchema = z.object({
  current_phase: z.string().nullable(),
  current_step: z.string().nullable(),
  steps: z.array(stepSummarySchema)
})

/** POST /projects/:id/steps/:stepId/run (SSE) */
export const runStepRequestSchema = z.strictObject({
  session_id: z.string().min(1),
  base_version: baseVersion,
  /**
   * Chạy lại một step đã `accepted` (B7 reopen): đặt `revision_requested`, reset `first_seq/last_seq/accepted_at`
   * rồi chạy như thường. Cần khi mục của step vẫn còn cờ đỏ dù step đã chốt — vd file có đầu mục nhưng I-4 không
   * trích được gì nên Spine trống (gặp thật 2026-09-20).
   */
  reopen: z.boolean().optional()
})

export const STEP_EVENT_TYPES = [
  "intake",
  "elicit",
  "answer_needed",
  "draft",
  "ops_applied",
  "render",
  "flags",
  "gate_ready",
  "error"
] as const

export const questionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  options: z.array(z.string()).optional(),
  multiple: z.boolean().optional()
})

/** Mỗi sự kiện SSE: `event: <type>` + `data: <JSON>` đúng schema dưới. */
export const stepEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("intake"), step_id: z.string(), phase: z.string(), empty_fields: z.array(z.string()) }),
  z.object({ type: z.literal("elicit"), step_id: z.string(), delta: z.string() }),
  z.object({ type: z.literal("answer_needed"), step_id: z.string(), questions: z.array(questionSchema) }),
  z.object({ type: z.literal("draft"), step_id: z.string(), attempt: z.number().int().min(1) }),
  z.object({
    type: z.literal("ops_applied"),
    step_id: z.string(),
    txn: z.string(),
    spine_version: baseVersion,
    changes: z.array(changeDiffSchema)
  }),
  z.object({
    type: z.literal("render"),
    step_id: z.string(),
    diagram_id: z.string(),
    render_status: z.enum(["ok", "error"]),
    error: z.string().optional()
  }),
  z.object({ type: z.literal("flags"), step_id: z.string(), red_open: z.number().int().min(0), yellow_open: z.number().int().min(0) }),
  z.object({
    type: z.literal("gate_ready"),
    step_id: z.string(),
    actions: z.array(gateActionSchema),
    regenerate_used: z.number().int().min(0),
    calls_used: z.number().int().min(0),
    /** Version cuối cùng của lượt chạy — CAO HƠN `ops_applied` vì render + recompute cờ chạy sau (L11). */
    spine_version: z.number().int().min(1),
    /** Lượt chạy này có ghi được op nào vào Spine không (L11b) — `false` = model trả lô rỗng. */
    wrote_ops: z.boolean(),
    /** Mục step này nuôi mà chạy xong vẫn trống — accept cũng không đóng được cờ `section_empty` (L11b). */
    empty_sections: z.array(z.object({ section_id: z.string(), title: z.string() }))
  }),
  z.object({ type: z.literal("error"), step_id: z.string(), code: pipelineErrorCodeSchema, message: z.string(), retryable: z.boolean() })
])

export type StepEvent = z.infer<typeof stepEventSchema>

/** Trần độ dài input người dùng ghi vào transcript (contract-change 2026-09-15). */
export const ANSWER_MAX_CHARS = 4000
export const ANSWERS_MAX_ITEMS = 20
export const GATE_NOTE_MAX_CHARS = 2000

const answerText = z.string().max(ANSWER_MAX_CHARS)

/** POST /projects/:id/steps/:stepId/answer */
export const stepAnswerRequestSchema = z.strictObject({
  session_id: z.string().min(1),
  answers: z
    .array(z.object({ question_id: z.string().min(1), answer: z.union([answerText, z.array(answerText).max(ANSWERS_MAX_ITEMS)]) }))
    .min(1)
    .max(ANSWERS_MAX_ITEMS)
})

/** POST /projects/:id/steps/:stepId/gate — revision/accept_as_is bắt buộc note (lý do). */
export const gateRequestSchema = z
  .strictObject({
    /** Session pipeline của project — cùng kiểm `NOT_PIPELINE_SESSION` như `/run`, `/answer`. */
    session_id: z.string().min(1),
    action: gateActionSchema,
    note: z.string().trim().min(1).max(GATE_NOTE_MAX_CHARS).optional(),
    base_version: baseVersion,
    /** S-5.4: Regenerate ở mức function. */
    function_id: z.string().min(1).optional()
  })
  .refine((v) => !(v.action === "revision" || v.action === "accept_as_is") || v.note !== undefined, {
    message: "revision và accept_as_is bắt buộc note",
    path: ["note"]
  })

export const gateResponseSchema = z.object({
  step: stepSummarySchema,
  next_step: z.string().nullable(),
  spine_version: baseVersion
})

// ─── progress / flags ────────────────────────────────────────────

export const sectionStatusSchema = z.enum(["derived", "stale", "accepted", "draft"])

/** GET /projects/:id/progress (T09) */
export const progressResponseSchema = z.object({
  readiness: z.object({
    accepted_pct: z.number().min(0).max(100),
    awaiting_reaccept: z.number().int().min(0),
    red_open: z.number().int().min(0),
    stale: z.number().int().min(0)
  }),
  progress: z.object({
    done: z.number().int().min(0),
    total: z.number().int().min(0),
    current_phase: z.string().nullable(),
    current_step: z.string().nullable(),
    show_percent: z.boolean()
  }),
  sections: z.array(
    z.object({
      id: z.string().min(1),
      status: sectionStatusSchema,
      awaiting_reaccept: z.boolean(),
      required: z.boolean(),
      derived: z.boolean()
    })
  )
})

/** POST /projects/:id/resume — revert step `in_progress` dang dở (nếu có) rồi trả tiến độ. */
export const resumeResponseSchema = z.object({
  reverted_step: z.string().nullable(),
  spine_version: baseVersion,
  progress: progressResponseSchema
})

/** GET /projects/:id/flags?level=&open= */
export const flagsQuerySchema = z.object({
  level: z.enum(["red", "yellow"]).optional(),
  open: z.enum(["true", "false"]).optional()
})
export const flagsResponseSchema = z.array(flagSchema)

/** POST /projects/:id/flags/:flagId/waive */
export const waiveRequestSchema = z.strictObject({ reason: z.string().trim().min(WAIVE_REASON_MIN_LENGTH) })
export const waiveResponseSchema = flagSchema

/** POST /projects/:id/flags/recompute */
export const recomputeFlagsRequestSchema = z.strictObject({ at_baseline: z.boolean().optional() })

// ─── traceability / document / export / baseline / diagram ───────

export const traceabilityEntitySchema = z.enum(["actor", "use_case", "function", "screen", "entity", "nfr", "feature", "business_rule"])

/** GET /projects/:id/traceability?entity=&id= */
export const traceabilityQuerySchema = z.object({ entity: traceabilityEntitySchema, id: z.string().min(1) })
export const traceabilityResponseSchema = z.object({
  nodes: z.array(z.object({ kind: traceabilityEntitySchema, id: z.string(), label: z.string() })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), field: z.string() }))
})

/** GET /projects/:id/document?source=draft|baseline&baseline_id= — trả RenderedDocument (T05). */
export const documentQuerySchema = z.object({
  source: z.enum(["draft", "baseline"]).default("draft"),
  baseline_id: z.string().min(1).optional()
})

/** POST /projects/:id/assemble (T15) */
export const assembleRequestSchema = z.strictObject({ base_version: baseVersion })
export const assembleResponseSchema = z.object({ spine_version: baseVersion, sections: z.number().int().min(0), generated_at: isoDateTime })

/** GET /projects/:id/export/word?source= — body là file .docx */
export const exportWordQuerySchema = documentQuerySchema

/** POST /projects/:id/baseline (T19) — 422 BASELINE_BLOCKED nếu còn cờ đỏ chưa waive. */
export const baselineRequestSchema = z.strictObject({ base_version: baseVersion })
export const baselineResponseSchema = baselineSchema
export const baselinesResponseSchema = z.array(baselineSchema)
