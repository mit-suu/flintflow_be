/**
 * Một version của tài liệu mode 1 (file .docx lưu GridFS). FLF-171, plan §5.3.
 * - `imported` — `0.0`: mode 1 v2 (FLF-184) `file_ref` = bản **render từ Spine** theo layout file upload + stamp;
 *   `original_ref` = file người dùng upload + stamp + bookmark neo (nút 1.10) để tải lại bản gốc.
 * - `cr_revision` — `0.1`, `0.2`…: `file_ref` = bản render sạch; `tracked_file_ref` (mode 1 v3) = cùng bản đó kèm Track Changes
 *   + comment tác giả = CR id so với version trước (nút 3.14).
 * - `release` — `1.0`, `2.0`…: `file_ref` giữ bản có Track Changes, `clean_file_ref` là bản accept-all (Flow 6).
 */

import mongoose, { Schema, Document } from "mongoose"
import { DOC_VERSION_KINDS, type DocVersionKind } from "./doc-version.constants.js"
import { DOC_VERSION_PATTERN } from "./versioning.js"

export interface IDocVersion extends Document {
  projectId: mongoose.Types.ObjectId
  version: string
  kind: DocVersionKind
  file_ref: string
  clean_file_ref: string | null
  /** Mode 1 v3 (BPMN 3.14, T6/T7): bản có đánh dấu so với version trước — chỉ `cr_revision`; dựng lỗi ⇒ `null`. */
  tracked_file_ref: string | null
  /** File người dùng upload (chỉ `imported`, FLF-184) — `null` với version render/CR/release. */
  original_ref: string | null
  /** Version làm gốc (`null` với `0.0`). */
  based_on: string | null
  /** CR đã ghi vào version này (`cr_revision`: đúng 1; `release`: mọi CR `written` từ lần release trước). */
  cr_ids: string[]
  /** `id` của entry `spine.baselines[]` (`imported`, `release`); `null` với `cr_revision`. */
  baseline_ref: string | null
  created_by: mongoose.Types.ObjectId
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
    original_ref: { type: String, default: null },
    based_on: { type: String, default: null },
    cr_ids: { type: [String], default: [] },
    baseline_ref: { type: String, default: null },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

docVersionSchema.index({ projectId: 1, version: 1 }, { unique: true })
docVersionSchema.index({ projectId: 1, createdAt: -1 })

export const DocVersion = mongoose.model<IDocVersion>("DocVersion", docVersionSchema)
