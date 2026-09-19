/**
 * Mã lỗi riêng của mode 1 (upload SRS có sẵn rồi sửa) — FLF-171, plan mode 1 §5.4.
 * Tài liệu: `docs/api/import-change-contract.md` §0.3. Mã chung (VALIDATION_ERROR, UNAUTHORIZED,
 * INSUFFICIENT_CREDIT, PROJECT_NOT_FOUND, SPINE_VERSION_CONFLICT, NOT_IMPLEMENTED…) giữ nguyên như
 * `pipeline.dto.ts`, không lặp lại ở đây.
 */

import { z } from "zod"
import { ApiError } from "../../shared/utils/api-error.js"

export const MODE1_ERROR_STATUS = {
  CR_SOURCE_REQUIRED: 400,
  IMPORT_NOT_FOUND: 404,
  DOC_VERSION_NOT_FOUND: 404,
  CR_NOT_FOUND: 404,
  STEP_NOT_IN_PLAN: 404,
  CR_LOCATION_NOT_FOUND: 404,
  CR_GROUP_NOT_FOUND: 404,
  PROJECT_MODE_MISMATCH: 409,
  IMPORT_NEEDS_LATEST_CONFIRM: 409,
  IMPORT_INVALID_STATE: 409,
  CR_REQUIRES_BASELINE: 409,
  CR_INVALID_TRANSITION: 409,
  BLOCK_LOCKED: 409,
  CR_LOCATION_UNCONCLUDED: 409,
  CR_OLD_TEXT_MISMATCH: 409,
  CHANGE_REQUIRES_CR: 409,
  /** FLF-182: tắt step của đầu mục mẫu FPT (cốt lõi) hoặc step đã có dữ liệu. */
  CORE_STEP_REQUIRED: 409,
  IMPORT_FILE_REJECTED: 422,
  IMPORT_STAMP_FOREIGN_PROJECT: 422,
  RELEASE_RED_FLAGS_OPEN: 422
} as const

export type Mode1ErrorCode = keyof typeof MODE1_ERROR_STATUS

export const mode1ErrorCodeSchema = z.enum(
  Object.keys(MODE1_ERROR_STATUS) as [Mode1ErrorCode, ...Mode1ErrorCode[]]
)

/** Lỗi mode 1 kèm `meta` (vd `BLOCK_LOCKED` ⇒ `{ locked: [{ block_id, cr_id }] }`). Controller đưa `meta` vào envelope. */
export class Mode1Error extends ApiError {
  readonly meta: Record<string, unknown> | undefined

  constructor(code: Mode1ErrorCode, message: string, meta?: Record<string, unknown>) {
    super(MODE1_ERROR_STATUS[code], message, code)
    this.meta = meta
  }
}
