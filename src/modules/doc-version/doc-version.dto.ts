/**
 * Zod request/response cho version tài liệu + release mode 1 (UC-54, UC-55, UC-57, Flow 6). FLF-171, plan §5.3 + §5.6.
 * Tài liệu: `docs/api/import-change-contract.md`.
 */

import { z } from "zod"
import { baselineSchema } from "../spine/spine.schema.js"
import { blockDiffEntrySchema, blockDiffSummarySchema, docBlockDtoSchema } from "../import/import.dto.js"
import { DOC_VERSION_PATTERN } from "./versioning.js"
import { DOC_VERSION_KINDS } from "./doc-version.constants.js"

const id = z.string().min(1)
const isoDateTime = z.iso.datetime({ offset: true })
export const docVersionString = z.string().regex(DOC_VERSION_PATTERN, "version dạng major.minor, vd 0.1")

export const docVersionDtoSchema = z.object({
  version: docVersionString,
  kind: z.enum(DOC_VERSION_KINDS),
  based_on: docVersionString.nullable(),
  cr_ids: z.array(z.string()),
  baseline_id: z.string().nullable(),
  /** Release có bản sạch để tải (UC-57). */
  has_clean_file: z.boolean(),
  /** Mode 1 v3: có bản Track Changes của CR (`variant=tracked`). */
  has_tracked_file: z.boolean(),
  /** Có file gốc người dùng upload (bản import 0.1, FLF-184) — tải qua `variant=original`. */
  has_original_file: z.boolean(),
  created_by: id,
  created_at: isoDateTime
})

// ─── gói duyệt (FLF-330, C-7) ────────────────────────────────────

export const reviewPackageCrSchema = z.object({
  cr_id: z.string(),
  title: z.string(),
  requester: z.string(),
  source: z.object({ kind: z.string(), ref: z.string().nullable() }),
  result_doc_version: docVersionString.nullable(),
  written_at: isoDateTime
})
export type ReviewPackageCrDto = z.infer<typeof reviewPackageCrSchema>

/**
 * `GET /projects/:id/review-package` — gói = mọi CR đã ghi kể từ lần phát hành trước (business-flow §3.2).
 * `status`: `drafting` (BA đang ghi) · `pending` (chờ Lead, bản nháp khoá) · `changes_requested` (Lead yêu cầu sửa).
 * `draft_label`: "1.0 · 3 thay đổi chưa duyệt" — chỉ số chính, không số phụ.
 */
export const reviewPackageSchema = z.object({
  status: z.enum(["drafting", "pending", "changes_requested"]),
  base_version: z.string().nullable(),
  latest_version: docVersionString.nullable(),
  next_version: docVersionString.nullable(),
  draft_label: z.string(),
  change_requests: z.array(reviewPackageCrSchema),
  red_open: z.number().int().min(0),
  submission: z
    .object({
      status: z.enum(["pending", "rejected"]),
      submitted_by: z.string(),
      submitted_at: isoDateTime,
      spine_version: z.number().int(),
      decided_by: z.string().nullable(),
      decided_at: isoDateTime.nullable(),
      reason: z.string().nullable(),
      rejection_comment_ids: z.array(z.string())
    })
    .nullable(),
  spine_version: z.number().int()
})
export type ReviewPackageDto = z.infer<typeof reviewPackageSchema>

export const submitPackageRequestSchema = z.strictObject({ base_version: z.number().int().min(1) })
export const requestChangesRequestSchema = z.strictObject({ base_version: z.number().int().min(1), reason: z.string().trim().min(10).max(2000) })

// ─── request ─────────────────────────────────────────────────────

export const versionParamsSchema = z.object({ v: docVersionString })

/**
 * `GET /projects/:id/versions/:v/download?variant=` —
 * `auto`: release ⇒ bản sạch; draft ⇒ bản Track Changes + watermark DRAFT, tên `…_v0.1_DRAFT.docx` (G8).
 * `tracked`: luôn bản có Track Changes (cả với release).
 * `original` (mode 1 v2, FLF-184): file người dùng upload của bản `0.1` (bản lưu `0.1` giờ là bản render từ Spine).
 */
export const downloadQuerySchema = z.object({ variant: z.enum(["auto", "tracked", "original"]).default("auto") })

/** `GET /projects/:id/versions/compare?from=&to=` (UC-55). */
export const compareQuerySchema = z
  .object({ from: docVersionString, to: docVersionString })
  .refine((q) => q.from !== q.to, { message: "from và to phải khác nhau" })

/** `POST /projects/:id/release` (Flow 6) — ghi baseline vào Spine ⇒ mang `base_version`. */
export const releaseRequestSchema = z.strictObject({ base_version: z.number().int().min(1) })

// ─── response ────────────────────────────────────────────────────

/** `GET /projects/:id/versions` — mới nhất trước. */
export const versionsResponseSchema = z.array(docVersionDtoSchema)

/** `GET /projects/:id/versions/:v/blocks` — theo thứ tự tài liệu. */
export const versionBlocksResponseSchema = z.array(docBlockDtoSchema)

export const compareResponseSchema = z.object({
  from: docVersionString,
  to: docVersionString,
  summary: blockDiffSummarySchema,
  blocks: z.array(blockDiffEntrySchema)
})

export const releaseResponseSchema = z.object({
  version: docVersionDtoSchema,
  baseline: baselineSchema,
  /** CR `written` từ lần release trước, gom vào bản này. */
  cr_ids: z.array(z.string()),
  spine_version: z.number().int().min(1)
})

export type DocVersionDto = z.infer<typeof docVersionDtoSchema>
export type CompareResponse = z.infer<typeof compareResponseSchema>
export type ReleaseResponse = z.infer<typeof releaseResponseSchema>
