/**
 * Kết quả so bản upload lại (stamp đúng project) với version tài liệu mới nhất — nút 1.4, UC-24.
 * **Không** tạo version: user xem diff rồi (tuỳ) tạo CR nguồn `reupload`. FLF-171, plan §5.2.
 * Khớp block theo bookmark `_ff_` → `para_id` → LCS trên `text_hash` (engine dùng chung với `versions/compare`).
 */

import mongoose, { Schema, Document } from "mongoose"
import { REUPLOAD_CHANGES, type ReuploadChange } from "./import.constants.js"

export interface BlockDiffEntry {
  /** `null` với block mới (`added`) chưa có id. */
  block_id: string | null
  change: ReuploadChange
  before?: string
  after?: string
}

export interface IReuploadDiff extends Document {
  projectId: mongoose.Types.ObjectId
  file_ref: string | null
  sha256: string
  original_name: string
  against_version: string
  blocks: BlockDiffEntry[]
  created_by: mongoose.Types.ObjectId
  createdAt: Date
}

const reuploadDiffSchema = new Schema<IReuploadDiff>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    file_ref: { type: String, default: null },
    sha256: { type: String, required: true },
    original_name: { type: String, required: true },
    against_version: { type: String, required: true },
    blocks: {
      type: [
        new Schema(
          {
            block_id: { type: String, default: null },
            change: { type: String, enum: REUPLOAD_CHANGES, required: true },
            before: String,
            after: String
          },
          { _id: false }
        )
      ],
      default: []
    },
    created_by: { type: Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

reuploadDiffSchema.index({ projectId: 1, createdAt: -1 })

export const ReuploadDiff = mongoose.model<IReuploadDiff>("ReuploadDiff", reuploadDiffSchema)
