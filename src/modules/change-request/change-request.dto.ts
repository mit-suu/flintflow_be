/**
 * Zod request/response cho API change request mode 1 (Flow 3, UC-48…UC-53, UC-81, UC-82). FLF-171, plan §5.4 + §5.6.
 * Tài liệu: `docs/api/import-change-contract.md`. Envelope `{ data, meta?, error }` như `pipeline.dto.ts`.
 */

import { z } from "zod"
import { CR_PAUSE_REASONS, CR_STATUSES } from "./change-request.state.js"
import {
  CR_ID_PATTERN,
  CR_SOURCE_KINDS,
  GROUP_DECISIONS,
  GROUP_ID_PATTERN,
  LOCATION_CONCLUSIONS,
  LOCATION_FOUND_BY,
  LOCATION_ID_PATTERN,
  CR_MATERIAL_KINDS,
  CR_MATERIAL_MAX_CHARS,
  MATERIAL_ID_PATTERN,
  NEW_CR_SOURCE_KINDS
} from "./change-request.constants.js"

const id = z.string().min(1)
const isoDateTime = z.iso.datetime({ offset: true })
const baseVersion = z.number().int().min(1)
const text = (max: number) => z.string().trim().min(1).max(max)

export const crIdSchema = z.string().regex(CR_ID_PATTERN, "cr_id dạng CR-001")
export const locationIdSchema = z.string().regex(LOCATION_ID_PATTERN, "location_id dạng L001")
export const materialIdSchema = z.string().regex(MATERIAL_ID_PATTERN, "material_id dạng M01")
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
  clarifications: z.array(
    z.object({
      round: z.number().int().min(1),
      questions: z.array(z.string()),
      answers: z.array(z.string()),
      /** Phase 7: đáp án AI gợi ý, song song `questions` (`[]` cho câu không có gợi ý). */
      suggestions: z.array(z.array(z.string()))
    })
  ),
  base_doc_version: z.string().min(1),
  result_doc_version: z.string().nullable(),
  created_by: id,
  submitted_at: isoDateTime.nullable(),
  decided_by: id.nullable(),
  closed_reason: z.string().nullable(),
  /** Mode 1 v3: bản xem trước đính kèm lúc tạo (gợi ý cho C-2/C-3/C-4), không có ⇒ `null`. */
  seed: z.object({ instruction: z.string().nullable(), ops: z.array(z.record(z.string(), z.unknown())), targets: z.array(z.string()) }).nullable(),
  /** Mode 1 v3 phase 7: tài liệu bổ sung (chữ đã tách) — ngữ cảnh cho C-2, C-4, 3.9. */
  materials: z.array(
    z.object({
      material_id: materialIdSchema,
      kind: z.enum(CR_MATERIAL_KINDS),
      name: z.string(),
      text: z.string(),
      truncated: z.boolean(),
      round: z.number().int().min(0),
      added_at: isoDateTime
    })
  ),
  /** Mode 1 v3 phase 7: dữ kiện C-2 báo vẫn thiếu khi hết vòng hỏi — C-4 sẽ phải giả định. */
  missing_info: z.array(z.string()),
  /** Phase 8: lệnh sửa gộp thêm (chat) theo thứ tự. */
  amendments: z.array(z.object({ text: z.string(), at: isoDateTime })),
  created_at: isoDateTime,
  updated_at: isoDateTime
})

/**
 * Vị trí CR — mode 1 v2 (FLF-186): phần tử Spine (`path`) + section hiển thị nó, thay `block_id`/`block` của file docx.
 * `current_text`: giá trị hiện tại của phần tử (JSON ổn định) để FE hiện mà không cần gọi thêm; `""` nếu đã bị xoá.
 */
export const changeLocationDtoSchema = z.object({
  location_id: locationIdSchema,
  path: z.string().min(1),
  section_id: z.string().min(1),
  section_title: z.string(),
  current_text: z.string(),
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
      spine_ops: z.array(z.unknown()),
      /** Mode 1 v3 phase 7: giả định AI đã dùng — người duyệt cần xác nhận. */
      assumptions: z.array(z.string())
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

/**
 * `POST /projects/:id/change-requests` (C-1, UC-48, BPMN 3.1). Thiếu `source` / `requester` ⇒ 400 CR_SOURCE_REQUIRED.
 * Mode 1 v3: nguồn chỉ nhận 6 nguồn của BPMN (không `chat`); `preview_id` đính kèm bản xem trước làm gợi ý.
 */
export const createChangeRequestSchema = z.strictObject({
  title: text(200),
  description: text(5000),
  source: crSourceSchema.extend({ kind: z.enum(NEW_CR_SOURCE_KINDS) }),
  requester: text(200),
  preview_id: z.string().trim().min(1).max(100).optional(),
  /** Mode 1 v3 phase 7: đoạn văn bản nguồn dán ở 3.1 (email, biên bản…) — file thì upload sau qua `/materials`. */
  materials: z.array(z.strictObject({ name: text(200), text: text(CR_MATERIAL_MAX_CHARS * 2) })).max(5).optional()
})

/** `GET /projects/:id/change-requests?status=` */
export const listChangeRequestsQuerySchema = z.object({ status: crStatusSchema.optional() })

export const crParamsSchema = z.object({ crId: crIdSchema })

/** `POST …/:crId/answers` (UC-49) — trả lời theo đúng thứ tự câu hỏi của vòng làm rõ gần nhất. */
/** Mode 1 v3 phase 7: câu trả lời được để trống (= "chưa biết") — C-2/C-4 coi dữ kiện đó là thiếu. */
export const answersRequestSchema = z.strictObject({ answers: z.array(z.string().trim().max(4000)).min(1).max(20) })

/** `POST …/:crId/amend` (phase 8): gộp thêm một lệnh sửa vào CR chưa nộp. */
export const amendRequestSchema = z.strictObject({ instruction: text(4000) })

/** `POST …/:crId/materials` dạng JSON (dán chữ). Upload file dùng multipart `file`. */
export const addMaterialRequestSchema = z.strictObject({ name: text(200), text: text(CR_MATERIAL_MAX_CHARS * 2) })

export const materialParamsSchema = z.object({ crId: crIdSchema, mid: materialIdSchema })

/** `PATCH …/:crId/locations/:locId` (UC-81) — sửa tay / kết luận tay ⇒ `manual = true`. */
export const patchLocationRequestSchema = z
  .strictObject({
    conclusion: z.enum(LOCATION_CONCLUSIONS).optional(),
    reason: text(2000).optional(),
    /** FLF-186: giá trị mới của cả phần tử ⇒ op `set` tại `path` của vị trí. */
    new_value: z.unknown().optional(),
    /** FLF-186: op Spine tự viết (định dạng `op.types.ts`), thay cho `new_value`. */
    spine_ops: z.array(z.record(z.string(), z.unknown())).min(1).max(50).optional(),
    comment_text: text(2000).optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Cần ít nhất một field để sửa" })
  .refine((v) => v.conclusion !== "edit" || v.new_value !== undefined || v.spine_ops !== undefined, {
    message: "Kết luận edit cần new_value hoặc spine_ops",
    path: ["new_value"]
  })
  .refine((v) => v.conclusion !== "comment" || v.comment_text !== undefined, { message: "Kết luận comment cần comment_text", path: ["comment_text"] })
  .refine((v) => v.conclusion !== "not_related" || v.reason !== undefined, { message: "Kết luận not_related cần lý do", path: ["reason"] })

/**
 * `POST …/:crId/groups/:gid/decision` (UC-52, BPMN 3.12 "quyết định từng group, kèm lý do"). Mode 1 v3: **cả duyệt
 * lẫn từ chối** đều bắt buộc lý do. Group cuối cùng được quyết mà có group duyệt ⇒ ghi (C-7) ⇒ mang `base_version`.
 */
export const groupDecisionRequestSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(DECISION_REASON_MIN_LENGTH, `Quyết định cần lý do ≥ ${DECISION_REASON_MIN_LENGTH} ký tự`).max(2000),
  base_version: baseVersion
})

/** `POST …/:crId/locations/:locId/owner-step-draft` (BPMN 3.9, mode 1 v3) — hướng sửa của BA cho skill step sở hữu. */
export const ownerStepDraftRequestSchema = z.strictObject({ instruction: text(4000) })

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

/** `meta` của 409 PATH_LOCKED (FLF-186) — phần tử Spine nào đang bị CR nào giữ. */
export const pathLockedMetaSchema = z.object({
  locked: z.array(z.object({ path: z.string(), cr_id: crIdSchema }))
})

/**
 * `meta` của 409 CHANGE_REQUIRES_CR — nội dung điền sẵn cho form 3.1 (mode 1 v3: BE không tự tạo CR; nguồn là gợi ý,
 * BA vẫn chọn lại). Bỏ `change_request` của V4/T8.
 */
export const changeRequiresCrMetaSchema = z.object({
  prefill: z.object({
    title: z.string(),
    description: z.string(),
    source: z.object({ kind: z.enum(CR_SOURCE_KINDS), ref: z.string().nullable() }).optional()
  })
})

/** `meta` của 409 CR_NO_LOCATIONS — C-3 ra 0 vị trí: đích của C-2 + các mục còn trống (kèm step soạn nội dung). */
export const crNoLocationsMetaSchema = z.object({
  targets: z.object({ entity_paths: z.array(z.string()), keywords: z.array(z.string()) }),
  empty_sections: z.array(z.object({ section_id: z.string(), title: z.string(), step_id: z.string().nullable() }))
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
