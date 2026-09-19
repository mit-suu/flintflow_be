/**
 * Mongoose model Baseline — snapshot Spine tại thời điểm baseline.
 * `Spine.baselines[].snapshot_ref` trỏ tới `_id` của document ở đây.
 * Bản sạch export render từ snapshot này, không từ Spine hiện tại (srs-spine.md §2.1).
 */

import mongoose, { Schema } from "mongoose"

const baselineSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    version: { type: String, required: true },
    type: { type: String, enum: ["generated", "imported", "release"], default: "generated" },
    doc_version: { type: String, default: null },
    at: { type: Date, required: true },
    checked_at_version: { type: Number, required: true, min: 1 },
    waived_count: { type: Number, default: 0, min: 0 },
    snapshot: { type: Schema.Types.Mixed, required: true }
  },
  { strict: true, minimize: false }
)

baselineSchema.index({ projectId: 1, at: -1 })
// Một version baseline chỉ tồn tại một lần trong project (mode 2: v1.0, v1.0-conditional, v1.1…; mode 1: 0.0, 1.0…)
baselineSchema.index({ projectId: 1, version: 1 }, { unique: true })

export const Baseline = mongoose.model("Baseline", baselineSchema)
