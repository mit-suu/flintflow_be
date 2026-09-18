/**
 * Zod request/response cho API change request mode 1 (Flow 3, UC-48…UC-53, UC-81, UC-82). FLF-171, plan §5.4 + §5.6.
 * Tài liệu: `docs/api/import-change-contract.md`. Envelope `{ data, meta?, error }` như `pipeline.dto.ts`.
 */

import { z } from "zod"
import { docBlockDtoSchema } from "../import/import.dto.js"
import { CR_PAUSE_REASONS, CR_STATUSES } from "./change-request.state.js"
import {
  CR_ID_PATTERN,
  CR_SOURCE_KINDS,
  GROUP_DECISIONS,
  GROUP_ID_PATTERN,
  LOCATION_CONCLUSIONS,
  LOCATION_FOUND_BY,
  LOCATION_ID_PATTERN
} from "./change-request.constants.js"

const id = z.string().min(1)
const isoDateTime = z.iso.datetime({ offset: true })
const baseVersion = z.number().int().min(1)
const text = (max: number) => z.string().trim().min(1).max(max)

export const crIdSchema = z.string().regex(CR_ID_PATTERN, "cr_id dạng CR-001")
export const locationIdSchema = z.string().regex(LOCATION_ID_PATTERN, "location_id dạng L001")
export const groupIdSchema = z.string().regex(GROUP_ID_PATTERN, "group_id dạng G01")

/** Lý do từ chối group / đóng / huỷ — đủ dài để có nghĩa khi đọc lại lịch sử. */
export const DECISION_REASON_MIN_LENGTH = 10

// ─── thành phần ──────────────────────────────────────────────────

export const crSourceSchema = z.strictObject({
  kind: z.enum(CR_SOURCE_KINDS),
  ref: z.string().trim().max(500).nullable().default(null),
  note: z.string().trim().max(2000).nullable().default(null)
})

export const crStatusSchema = z.enum(CR_STATUSES)

export const changeRequestDtoSchema = z.object({
  cr_id: crIdSchema,
  project_id: id,
  title: z.string(),
  description: z.string(),
  source: crSourceSchema,
  requester: z.string(),
  status: crStatusSchema,
  paused: z.object({ reason: z.enum(CR_PAUSE_REASONS), at: isoDateTime }).nullable(),
  clarifications: z.array(z.object({ round: z.number().int().min(1), questions: z.array(z.string()), answers: z.array(z.string()) })),
  base_doc_version: z.string().min(1),
  result_doc_version: z.string().nullable(),
  created_by: id,
  submitted_at: isoDateTime.nullable(),
  decided_by: id.nullable(),
  closed_reason: z.string().nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime
})

export const changeLocationDtoSchema = z.object({
  location_id: locationIdSchema,
  block_id: z.string().min(1),
  /** Block hiện tại (text, kind, heading_path) để FE hiện mà không cần gọi thêm. */
  block: docBlockDtoSchema.nullable(),
  found_by: z.array(z.enum(LOCATION_FOUND_BY)),
  entity_paths: z.array(z.string()),
  owner_step: z.string().nullable(),
  conclusion: z.enum(LOCATION_CONCLUSIONS).nullable(),
  reason: z.string().nullable(),
  proposal: z
    .object({
      old_text: z.string(),
      new_text: z.string().nullable(),
      comment_text: z.string().nullable(),
      spine_ops: z.array(z.unknown())
    })
    .nullable(),
  manual: z.boolean(),
  redo_count: z.number().int().min(0).max(2),
  verify: z
    .object({
      code_ok: z.boolean(),
      violations: z.array(z.object({ rule: z.string(), message: z.string(), path: z.string().optional() })),
      ai_flags: z.array(z.object({ rule: z.string(), message: z.string() })),
      at: isoDateTime
    })
    .nullable(),
  group_id: groupIdSchema.nullable()
})

export const changeGroupDtoSchema = z.object({
  group_id: groupIdSchema,
  title: z.string(),
  location_ids: z.array(locationIdSchema),
  decision: z.enum(GROUP_DECISIONS),
  reason: z.string().nullable(),
  decided_by: id.nullable(),
  decided_at: isoDateTime.nullable()
})

// ─── request ─────────────────────────────────────────────────────

/** `POST /projects/:id/change-requests` (C-1, UC-48). Thiếu `source` ⇒ 400 CR_SOURCE_REQUIRED. */
export const createChangeRequestSchema = z.strictObject({
  title: text(200),
  description: text(5000),
  source: crSourceSchema,
  requester: text(200)
})

/** `GET /projects/:id/change-requests?status=` */
export const listChangeRequestsQuerySchema = z.object({ status: crStatusSchema.optional() })

export const crParamsSchema = z.object({ crId: crIdSchema })

/** `POST …/:crId/answers` (UC-49) — trả lời theo đúng thứ tự câu hỏi của vòng làm rõ gần nhất. */
export const answersRequestSchema = z.strictObject({ answers: z.array(text(4000)).min(1).max(20) })

/** `PATCH …/:crId/locations/:locId` (UC-81) — sửa tay / kết luận tay ⇒ `manual = true`. */
export const patchLocationRequestSchema = z
  .strictObject({
    conclusion: z.enum(LOCATION_CONCLUSIONS).optional(),
    reason: text(2000).optional(),
    new_text: z.string().max(20000).optional(),
    comment_text: text(2000).optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Cần ít nhất một field để sửa" })
  .refine((v) => v.conclusion !== "edit" || v.new_text !== undefined, { message: "Kết luận edit cần new_text", path: ["new_text"] })
  .refine((v) => v.conclusion !== "comment" || v.comment_text !== undefined, { message: "Kết luận comment cần comment_text", path: ["comment_text"] })
  .refine((v) => v.conclusion !== "not_related" || v.reason !== undefined, { message: "Kết luận not_related cần lý do", path: ["reason"] })

/**
 * `POST …/:crId/groups/:gid/decision` (UC-52). Từ chối bắt buộc có lý do. Group cuối cùng được quyết mà có
 * group duyệt ⇒ ghi Track Changes + áp op Spine (C-7) ⇒ mang `base_version`.
 */
export const groupDecisionRequestSchema = z
  .strictObject({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().max(2000).optional(),
    base_version: baseVersion
  })
  .refine((v) => v.decision === "approved" || (v.reason?.length ?? 0) >= DECISION_REASON_MIN_LENGTH, {
    message: `Từ chối cần lý do ≥ ${DECISION_REASON_MIN_LENGTH} ký tự`,
    path: ["reason"]
  })

/** `POST …/:crId/close` (3.13) và `POST …/:crId/cancel` (3.10, UC-53). */
export const closeRequestSchema = z.strictObject({ reason: z.string().trim().min(DECISION_REASON_MIN_LENGTH).max(2000) })

/** `POST …/:crId/clarify`, `/impact`, `/propose`, `/verify`, `/submit`, `/revise`, `/resume` — không có body. */
export const emptyRequestSchema = z.strictObject({})

// ─── response ────────────────────────────────────────────────────

/** `GET …/change-requests` — mới nhất trước. */
export const listChangeRequestsResponseSchema = z.array(changeRequestDtoSchema)

/** `GET …/:crId` và phản hồi của mọi hành động trên CR (clarify, answers, impact, propose, verify, submit, decision…). */
export const changeRequestDetailSchema = z.object({
  change_request: changeRequestDtoSchema,
  locations: z.array(changeLocationDtoSchema),
  groups: z.array(changeGroupDtoSchema),
  /** Câu hỏi của vòng làm rõ đang chờ trả lời (`awaiting_answers`), rỗng nếu không chờ. */
  pending_questions: z.array(z.string())
})

/** `meta` của 409 BLOCK_LOCKED — block nào đang bị CR nào giữ. */
export const blockLockedMetaSchema = z.object({
  locked: z.array(z.object({ block_id: z.string(), cr_id: crIdSchema }))
})

/** `meta` của 409 CHANGE_REQUIRES_CR (chat / `/changes` / `/undo` ở project mode 1, G9) — FE mở form CR điền sẵn. */
export const changeRequiresCrMetaSchema = z.object({
  prefill: z.object({ title: z.string(), description: z.string() })
})

/** `meta` của 409 CR_LOCATION_UNCONCLUDED. */
export const locationUnconcludedMetaSchema = z.object({ location_ids: z.array(locationIdSchema) })

export type ChangeRequestDto = z.infer<typeof changeRequestDtoSchema>
export type ChangeLocationDto = z.infer<typeof changeLocationDtoSchema>
export type ChangeGroupDto = z.infer<typeof changeGroupDtoSchema>
export type ChangeRequestDetail = z.infer<typeof changeRequestDetailSchema>
export type CreateChangeRequest = z.infer<typeof createChangeRequestSchema>
export type PatchLocationRequest = z.infer<typeof patchLocationRequestSchema>
export type GroupDecisionRequest = z.infer<typeof groupDecisionRequestSchema>
