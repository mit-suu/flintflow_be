/**
 * Zod request/response cho version tài liệu + release mode 1 (UC-54, UC-55, UC-57, Flow 6). FLF-171, plan §5.3 + §5.6.
 * Tài liệu: `docs/api/import-change-contract.md`.
 */

import { z } from "zod"
import { baselineSchema } from "../spine/spine.schema.js"
import { blockDiffEntrySchema, blockDiffSummarySchema, diffSectionStatSchema, docBlockDtoSchema } from "../import/import.dto.js"
import { DOC_VERSION_PATTERN } from "./versioning.js"
import { DOC_VERSION_KINDS, SYSTEM_CHANGE_TYPES } from "./doc-version.constants.js"

const id = z.string().min(1)
const isoDateTime = z.iso.datetime({ offset: true })
export const docVersionString = z.string().regex(DOC_VERSION_PATTERN, "version dạng major.minor, vd 0.1")

export const docVersionDtoSchema = z.object({
  version: docVersionString,
  kind: z.enum(DOC_VERSION_KINDS),
  based_on: docVersionString.nullable(),
  cr_ids: z.array(z.string()),
  baseline_id: z.string().nullable(),
  /** FLF-466: chỉ `kind = system_change` (đổi mẫu / hoàn tác / vẽ lại màn); version khác ⇒ `null`. */
  system_change: z.object({ type: z.enum(SYSTEM_CHANGE_TYPES), ref: z.string(), summary: z.string() }).nullable(),
  /** Release có bản sạch để tải (UC-57). */
  has_clean_file: z.boolean(),
  /** Mode 1 v3: có bản Track Changes của CR (`variant=tracked`). */
  has_tracked_file: z.boolean(),
  /** FLF-466: release không có bản Track Changes vì sao; có hoặc không áp dụng => `null`. */
  tracked_unavailable_reason: z.enum(["template_translated", "build_failed"]).nullable(),
  /** Có file gốc người dùng upload (bản import 0.1, FLF-184) — tải qua `variant=original`. */
  has_original_file: z.boolean(),
  /**
   * FLF-334 B: tải được theo ngôn ngữ còn lại (`?lang=`) — chỉ version có baseline (release / bản chuyển đổi) của dự án
   * chuyển từ mode 2. `false` ⇒ FE ẩn lựa chọn ngôn ngữ.
   */
  other_language_available: z.boolean(),
  /** FLF-466: mã dự án ngắn (`P` + 6 ký tự cuối `_id`) dùng ghép tên file khi tải. */
  project_code: z.string().optional(),
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

/** FLF-466: mỗi thay đổi hệ thống (đổi mẫu, hoàn tác, vẽ lại / dùng ảnh gốc) một dòng riêng trong Gói duyệt. */
export const reviewPackageSystemChangeSchema = z.object({
  /** Số phụ của bản nháp chứa thay đổi này (1.3). */
  version: docVersionString,
  type: z.enum(SYSTEM_CHANGE_TYPES),
  ref: z.string(),
  summary: z.string(),
  created_by: z.string(),
  created_at: isoDateTime
})
export type ReviewPackageSystemChangeDto = z.infer<typeof reviewPackageSystemChangeSchema>

/**
 * FLF-480 (B13): một vòng "Yêu cầu sửa" trước lần gửi lại hiện tại — `submitPackage` ghi đè `baseline_submission`
 * nên lý do của vòng trước chỉ còn lại ở change log; `getPackage` dựng lại từ đó để không mất lý do khi gửi lại.
 */
export const reviewPackageRoundSchema = z.object({
  decided_by: z.string(),
  decided_at: isoDateTime,
  reason: z.string().nullable()
})
export type ReviewPackageRoundDto = z.infer<typeof reviewPackageRoundSchema>

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
  /** FLF-466: thay đổi hệ thống kể từ lần phát hành trước, theo thứ tự ghi. Gói chỉ có mục này vẫn gửi / phát hành được. */
  system_changes: z.array(reviewPackageSystemChangeSchema),
  /** FLF-466: phát hành gói này sẽ không có bản Track Changes (`template_translated`: có đổi mẫu kèm dịch); còn lại `null`. */
  tracked_unavailable_reason: z.enum(["template_translated"]).nullable(),
  red_open: z.number().int().min(0),
  /** FLF-492: credit ước tính để AI viết gọn các dòng CR của gói (0 khi không có dòng nào cần viết). */
  concise_record_credits: z.number().int().min(0),
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
  spine_version: z.number().int(),
  /** FLF-480 (B13): các vòng "Yêu cầu sửa" trước lần gửi lại hiện tại, mới nhất trước — thêm field, additive. */
  rounds: z.array(reviewPackageRoundSchema)
})
export type ReviewPackageDto = z.infer<typeof reviewPackageSchema>

export const submitPackageRequestSchema = z.strictObject({ base_version: z.number().int().min(1) })
export const requestChangesRequestSchema = z.strictObject({ base_version: z.number().int().min(1), reason: z.string().trim().min(10).max(2000) })

// ─── request ─────────────────────────────────────────────────────

export const versionParamsSchema = z.object({ v: docVersionString })

/**
 * `GET /projects/:id/versions/:v/download?variant=` —
 * `auto`: release ⇒ bản sạch; draft ⇒ bản Track Changes + watermark DRAFT (G8). Tên + stamp theo FLF-334 (`versionFileName`):
 *   `<tên>_v1.0+CR-014_DRAFT.docx`, `<tên>_v0.1_DRAFT.docx` (chưa release ⇒ số bản import, FLF-356), release `<tên>_v2.0.docx`.
 * `tracked`: luôn bản có Track Changes (cả với release).
 * `original` (mode 1 v2, FLF-184): file người dùng upload của bản `0.1` (bản lưu `0.1` giờ là bản render từ Spine).
 */
/** `format=pdf` (FLF-316): chính file .docx của variant đó chuyển qua Gotenberg; `original` chỉ có .docx. */
/**
 * `lang=vi|en` (FLF-334 B): không truyền / trùng ngôn ngữ tài liệu ⇒ như trước. Khác ⇒ dựng lại từ snapshot baseline của
 * version theo ngôn ngữ đó (chỉ `variant=auto`; version không có baseline / dự án import thật ⇒ 409
 * `DOCUMENT_LANGUAGE_UNAVAILABLE`; thiếu bản dịch ⇒ 409 `TRANSLATION_INCOMPLETE`).
 */
export const downloadQuerySchema = z.object({
  variant: z.enum(["auto", "tracked", "original"]).default("auto"),
  format: z.enum(["docx", "pdf"]).default("docx"),
  lang: z.enum(["vi", "en"]).optional()
})

/** `GET /projects/:id/versions/compare?from=&to=` (UC-55). */
export const compareQuerySchema = z
  .object({ from: docVersionString, to: docVersionString })
  .refine((q) => q.from !== q.to, { message: "from và to phải khác nhau" })

/**
 * `POST /projects/:id/release` (Flow 6) — ghi baseline vào Spine ⇒ mang `base_version`. `concise_record` (FLF-492, M4-02): AI viết gọn
 * mô tả các dòng CR trong Record of Changes; không truyền / `false` ⇒ câu dựng sẵn từ thay đổi, không tốn credit.
 */
export const releaseRequestSchema = z.strictObject({ base_version: z.number().int().min(1), concise_record: z.boolean().optional() })

// ─── response ────────────────────────────────────────────────────

/** `GET /projects/:id/versions` — mới nhất trước. */
export const versionsResponseSchema = z.array(docVersionDtoSchema)

/** `GET /projects/:id/versions/:v/blocks` — theo thứ tự tài liệu. */
export const versionBlocksResponseSchema = z.array(docBlockDtoSchema)

export const compareResponseSchema = z.object({
  from: docVersionString,
  to: docVersionString,
  summary: blockDiffSummarySchema,
  blocks: z.array(blockDiffEntrySchema),
  sections: z.array(diffSectionStatSchema)
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
