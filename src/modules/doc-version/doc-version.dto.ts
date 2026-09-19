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
  created_by: id,
  created_at: isoDateTime
})

// ─── request ─────────────────────────────────────────────────────

export const versionParamsSchema = z.object({ v: docVersionString })

/**
 * `GET /projects/:id/versions/:v/download?variant=` —
 * `auto`: release ⇒ bản sạch; draft ⇒ bản Track Changes + watermark DRAFT, tên `…_v0.2_DRAFT.docx` (G8).
 * `tracked`: luôn bản có Track Changes (cả với release).
 */
export const downloadQuerySchema = z.object({ variant: z.enum(["auto", "tracked"]).default("auto") })

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
