/**
 * Một version của tài liệu mode 1 (file .docx lưu GridFS). FLF-171, plan §5.3.
 * - `imported` — `0.0`, file người dùng upload + stamp + bookmark neo (nút 1.10).
 * - `cr_revision` — `0.1`, `0.2`…: bản trước + Track Changes/comment author = CR id (nút 3.14).
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
