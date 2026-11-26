import type { ChangeRecordRow } from "../render/section-renderer.js"
/**
 * Một version của tài liệu mode 1 (file .docx lưu GridFS). FLF-171, plan §5.3.
 * - `imported` — `0.1`: mode 1 v2 (FLF-184) `file_ref` = bản **render từ Spine** theo layout file upload + stamp;
 *   `original_ref` = file người dùng upload + stamp + bookmark neo (nút 1.10) để tải lại bản gốc.
 * - `cr_revision` — `0.1`, `0.2`…: `file_ref` = bản render sạch; `tracked_file_ref` (mode 1 v3) = cùng bản đó kèm Track Changes
 *   + comment tác giả = CR id so với version trước (nút 3.14).
 * - `system_change` (FLF-466) — số phụ kế tiếp: đổi mẫu / hoàn tác đổi mẫu / vẽ lại màn sau baseline; `cr_ids: []`, `system_change` mô tả.
 * - `release` — `1.0`, `2.0`…: `file_ref` = `clean_file_ref` = bản render sạch; `tracked_file_ref` (FLF-466 / FLF-484) = Track Changes gộp mọi thay đổi kể từ lần phát hành trước (Flow 6).
 */

import type { Spine } from "../spine/spine.types.js"
import type { TemplateSourceBinding } from "./template-source-binding.js"
import mongoose, { Schema, Document } from "mongoose"
import { DOC_VERSION_KINDS, SYSTEM_CHANGE_TYPES, type DocVersionKind, type SystemChangeInfo } from "./doc-version.constants.js"
import { DOC_VERSION_PATTERN } from "./versioning.js"

export interface IDocVersion extends Document {
  projectId: mongoose.Types.ObjectId
  version: string
  kind: DocVersionKind
  file_ref: string
  clean_file_ref: string | null
  /** Mode 1 v3 (BPMN 3.14, T6/T7): bản có đánh dấu so với version trước (`cr_revision`) hoặc so với lần phát hành trước (`release`); dựng lỗi / đổi mẫu có dịch ở giữa ⇒ `null`. */
  tracked_file_ref: string | null
  /** FLF-466: `release` không có bản Track Changes vì sao (`template_translated` đổi mẫu kèm dịch, `build_failed`); có / không áp dụng ⇒ `null`. */
  tracked_unavailable_reason?: "template_translated" | "build_failed" | null
  /** File người dùng upload (chỉ `imported`, FLF-184) — `null` với version render/CR/release. */
  original_ref: string | null
  /** Version làm gốc (`null` với `0.1`). */
  based_on: string | null
  /** CR đã ghi vào version này (`cr_revision`: đúng 1; `release`: mọi CR `written` từ lần release trước). */
  cr_ids: string[]
  /** `id` của entry `spine.baselines[]` (`imported`, `release`); `null` với `cr_revision`. */
  baseline_ref: string | null
  /** FLF-466: chỉ `system_change`. */
  system_change?: SystemChangeInfo | null
  created_by: mongoose.Types.ObjectId
  template_source?: TemplateSourceBinding | null
  spine_snapshot?: Spine | null
  record_snapshot?: ChangeRecordRow[] | null
  fixed_render_cache?: { revision: string; file_ref: string } | null
  createdAt: Date
}

const docVersionSchema = new Schema<IDocVersion>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    version: { type: String, required: true, match: DOC_VERSION_PATTERN },
    kind: { type: String, enum: DOC_VERSION_KINDS, required: true },
    file_ref: { type: String, required: true },
    clean_file_ref: { type: String, default: null },
    tracked_file_ref: { type: String, default: null },
    tracked_unavailable_reason: { type: String, enum: ["template_translated", "build_failed", null], default: null },
    original_ref: { type: String, default: null },
    based_on: { type: String, default: null },
    cr_ids: { type: [String], default: [] },
    baseline_ref: { type: String, default: null },
    system_change: {
      type: new Schema({ type: { type: String, enum: SYSTEM_CHANGE_TYPES, required: true }, ref: { type: String, required: true }, summary: { type: String, required: true } }, { _id: false }),
      default: null
    },
    template_source: { type: Schema.Types.Mixed, default: null },
    spine_snapshot: { type: Schema.Types.Mixed, default: null },
    record_snapshot: { type: [Schema.Types.Mixed], default: null },
    fixed_render_cache: { type: Schema.Types.Mixed, default: null },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

docVersionSchema.index({ projectId: 1, version: 1 }, { unique: true })
docVersionSchema.index({ projectId: 1, createdAt: -1 })
docVersionSchema.index({ projectId: 1, "system_change.ref": 1 }, { partialFilterExpression: { "system_change.ref": { $type: "string" } } })

export const DocVersion = mongoose.model<IDocVersion>("DocVersion", docVersionSchema)
