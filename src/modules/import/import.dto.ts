/**
 * Zod request/response cho API import mode 1 (nút 1.1–1.13, UC-19…UC-24). FLF-171, plan §5.2 + §5.6.
 * Tài liệu: `docs/api/import-change-contract.md` §1–§2. Hình dữ liệu trên dây (ISO string, `id` là string);
 * ánh xạ từ model sang DTO làm ở service (P2).
 * Envelope `{ data, meta?, error }` như `pipeline.dto.ts`.
 */

import { z } from "zod"
import { baselineSchema, flagSchema } from "../spine/spine.schema.js"
import { IMPORT_PAUSE_REASONS, IMPORT_STATUSES } from "./import.state.js"
import {
  BLOCK_ID_PATTERN,
  DOC_BLOCK_KINDS,
  EXTRACTION_STATUSES,
  HEADING_DETECTORS,
  MENTION_ENTITIES,
  PREFLIGHT_ISSUE_CODES,
  REUPLOAD_CHANGES
} from "./import.constants.js"

const id = z.string().min(1)
const isoDateTime = z.iso.datetime({ offset: true })
const confidence = z.number().min(0).max(1)
const blockId = z.string().regex(BLOCK_ID_PATTERN, "block_id dạng B0001")
const baseVersion = z.number().int().min(1)

// ─── thành phần ──────────────────────────────────────────────────

export const importStatusSchema = z.enum(IMPORT_STATUSES)

export const preflightIssueSchema = z.object({
  code: z.enum(PREFLIGHT_ISSUE_CODES),
  message: z.string(),
  location: z.object({ block_ord: z.number().int().min(0), text: z.string() }).nullable().optional()
})

export const docStampSchema = z.object({
  project_id: id,
  version: z.string().nullable(),
  source: z.string().nullable()
})

export const importPausedSchema = z.object({ reason: z.enum(IMPORT_PAUSE_REASONS), at: isoDateTime })

export const importedDocumentDtoSchema = z.object({
  id,
  project_id: id,
  original_name: z.string(),
  size: z.number().int().min(0),
  sha256: z.string().length(64),
  status: importStatusSchema,
  preflight: z.object({ status: z.enum(["accepted", "rejected"]), issues: z.array(preflightIssueSchema) }),
  stamp: docStampSchema.nullable(),
  confirmed_latest_at: isoDateTime.nullable(),
  paused: importPausedSchema.nullable(),
  extract_cursor: z.string().nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime
})

export const docBlockDtoSchema = z.object({
  block_id: blockId,
  doc_version: z.string().min(1),
  kind: z.enum(DOC_BLOCK_KINDS),
  level: z.number().int().min(0).max(9).nullable(),
  heading_path: z.array(z.string()),
  text: z.string(),
  section_id: z.string().nullable(),
  mentions: z.array(z.object({ entity: z.enum(MENTION_ENTITIES), id })),
  editable: z.boolean(),
  locked_by_cr: z.string().nullable(),
  /** Chỉ có ở version draft có Track Changes (UC-54): đoạn chèn/xoá do CR ghi, để FE tô màu. */
  revisions: z
    .array(z.object({ kind: z.enum(["ins", "del"]), text: z.string(), author: z.string() }))
    .optional()
})

export const headingMapEntrySchema = z.object({
  block_id: blockId,
  heading_text: z.string(),
  section_id: z.string().min(1),
  confidence,
  detected_by: z.enum(HEADING_DETECTORS),
  confirmed: z.boolean()
})

export const tableMapEntrySchema = z.object({
  block_id: blockId,
  column_index: z.number().int().min(0),
  header: z.string(),
  field_path: z.string().nullable(),
  confidence,
  confirmed: z.boolean()
})

export const templateProfileDtoSchema = z.object({
  doc_version: z.string().min(1),
  heading_map: z.array(headingMapEntrySchema),
  table_map: z.array(tableMapEntrySchema),
  required_sections: z.array(z.string()),
  language: z.string()
})

export const reviewFieldSchema = z.object({
  section_id: z.string().min(1),
  path: z.string().min(1),
  value: z.unknown(),
  confidence,
  source_block_ids: z.array(blockId),
  origin: z.enum(["deterministic", "ai"]),
  confirmed: z.boolean(),
  edited_value: z.unknown().optional()
})

export const extractionSectionSchema = z.object({
  section_id: z.string().min(1),
  status: z.enum(EXTRACTION_STATUSES),
  fields_total: z.number().int().min(0),
  fields_needing_review: z.number().int().min(0),
  error: z.string().nullable()
})

// ─── request ─────────────────────────────────────────────────────

/** `POST /projects/:id/import` — multipart, field `file` (.docx ≤ 10MB). Không có body JSON. */
export const IMPORT_FILE_FIELD = "file"

/** `POST /projects/:id/import/confirm-latest` (nút 1.3). */
export const confirmLatestRequestSchema = z.strictObject({ import_id: id })

/** `PATCH /projects/:id/import/mapping` (UC-21, nút 1.7). Mục gửi lên ⇒ `confirmed = true`. */
export const mappingPatchRequestSchema = z
  .strictObject({
    import_id: id,
    headings: z.array(z.strictObject({ block_id: blockId, section_id: z.string().min(1) })).default([]),
    tables: z
      .array(z.strictObject({ block_id: blockId, column_index: z.number().int().min(0), field_path: z.string().min(1).nullable() }))
      .default([]),
    /** `true` ⇒ xác nhận luôn mọi mục còn lại theo gợi ý và chuyển `extracting`. */
    confirm_all: z.boolean().default(false)
  })
  .refine((v) => v.headings.length > 0 || v.tables.length > 0 || v.confirm_all, {
    message: "Cần ít nhất một mục mapping hoặc confirm_all"
  })

/** `POST /projects/:id/import/extract` (nút 1.8) — chạy hoặc chạy tiếp I-4 từ `extract_cursor`. */
export const extractRequestSchema = z.strictObject({ import_id: id })

/** `PATCH /projects/:id/import/fields` (UC-22, nút 1.9). */
export const fieldsPatchRequestSchema = z
  .strictObject({
    import_id: id,
    fields: z
      .array(
        z.strictObject({
          section_id: z.string().min(1),
          path: z.string().min(1),
          /** `false` ⇒ bỏ field này (không ghi vào Spine). */
          confirmed: z.boolean(),
          edited_value: z.unknown().optional()
        })
      )
      .default([]),
    /** `true` ⇒ xác nhận mọi field còn lại theo giá trị AI trích và chuyển `baselining`. */
    confirm_all: z.boolean().default(false)
  })
  .refine((v) => v.fields.length > 0 || v.confirm_all, { message: "Cần ít nhất một field hoặc confirm_all" })

/** `POST /projects/:id/import/finalize` (nút 1.10–1.12) — ghi Spine ⇒ mang `base_version`. */
export const finalizeRequestSchema = z.strictObject({ import_id: id, base_version: baseVersion })

/** `POST /projects/:id/import/resume` (UC-61, UC-75). */
export const importResumeRequestSchema = z.strictObject({ import_id: id })

/** `GET /projects/:id/gap-report?format=json|docx` (UC-23). */
export const gapReportQuerySchema = z.object({ format: z.enum(["json", "docx"]).default("json") })

// ─── response ────────────────────────────────────────────────────

/** `POST /import`, `POST /import/confirm-latest`, `PATCH /import/mapping`, `PATCH /import/fields`, `POST /import/resume`. */
export const importStateResponseSchema = z.object({ import: importedDocumentDtoSchema })

/** `GET /projects/:id/import` (UC-19) — `import = null` khi project chưa upload. */
export const getImportResponseSchema = z.object({
  import: importedDocumentDtoSchema.nullable(),
  profile: templateProfileDtoSchema.nullable(),
  extraction: z.object({
    sections: z.array(extractionSectionSchema),
    /** Field độ tin < 0.7 chưa xác nhận (nút 1.9). */
    review_fields: z.array(reviewFieldSchema)
  }),
  blocks_count: z.number().int().min(0)
})

/** `POST /projects/:id/import/extract` — trả khi chạy xong hoặc khi pause (hết credit / lỗi AI 2 lần). */
export const extractResponseSchema = z.object({
  import: importedDocumentDtoSchema,
  sections: z.array(extractionSectionSchema)
})

/** `POST /projects/:id/import/finalize`. */
export const finalizeResponseSchema = z.object({
  import: importedDocumentDtoSchema,
  doc_version: z.literal("0.0"),
  baseline: baselineSchema,
  spine_version: z.number().int().min(1),
  flags: z.object({ red: z.number().int().min(0), yellow: z.number().int().min(0) })
})

export const gapReportSchema = z.object({
  project_id: id,
  doc_version: z.string().min(1),
  generated_at: isoDateTime,
  totals: z.object({
    red: z.number().int().min(0),
    yellow: z.number().int().min(0),
    missing_sections: z.number().int().min(0),
    unmapped_headings: z.number().int().min(0),
    low_confidence_fields: z.number().int().min(0)
  }),
  /** Cờ đỏ/vàng gộp theo section (chỉ section có cờ). */
  sections: z.array(z.object({ section_id: z.string(), title: z.string(), flags: z.array(flagSchema) })),
  missing_sections: z.array(z.object({ section_id: z.string(), title: z.string() })),
  unmapped_headings: z.array(z.object({ block_id: blockId, text: z.string() })),
  low_confidence_fields: z.array(reviewFieldSchema)
})

/** `GET /projects/:id/gap-report` (format=json). `format=docx` trả file, không bọc envelope. */
export const gapReportResponseSchema = gapReportSchema

/** Một dòng diff theo block — dùng chung cho re-upload (UC-24) và `versions/compare` (UC-55). */
export const blockDiffEntrySchema = z.object({
  block_id: blockId.nullable(),
  change: z.enum(REUPLOAD_CHANGES),
  before: z.string().optional(),
  after: z.string().optional()
})

export const blockDiffSummarySchema = z.object({
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  modified: z.number().int().min(0),
  moved: z.number().int().min(0)
})

export const reuploadDiffDtoSchema = z.object({
  id,
  original_name: z.string(),
  against_version: z.string().min(1),
  created_at: isoDateTime,
  summary: blockDiffSummarySchema,
  blocks: z.array(blockDiffEntrySchema)
})

/** `POST /projects/:id/reupload` (UC-24, nút 1.4) — multipart như `/import`. */
export const reuploadResponseSchema = reuploadDiffDtoSchema

export type ImportedDocumentDto = z.infer<typeof importedDocumentDtoSchema>
export type DocBlockDto = z.infer<typeof docBlockDtoSchema>
export type TemplateProfileDto = z.infer<typeof templateProfileDtoSchema>
export type ReviewField = z.infer<typeof reviewFieldSchema>
export type MappingPatchRequest = z.infer<typeof mappingPatchRequestSchema>
export type FieldsPatchRequest = z.infer<typeof fieldsPatchRequestSchema>
export type FinalizeRequest = z.infer<typeof finalizeRequestSchema>
export type GetImportResponse = z.infer<typeof getImportResponseSchema>
export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>
export type GapReport = z.infer<typeof gapReportSchema>
export type ReuploadDiffDto = z.infer<typeof reuploadDiffDtoSchema>
