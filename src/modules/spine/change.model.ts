/**
 * Mongoose model Change — lịch sử op của Spine (srs-spine.md §2 `changes[]`).
 * Tách collection vì giới hạn 16MB của một document Mongo.
 * Nguồn cho undo, diff, resume và section §I Record of Changes.
 */

import mongoose, { Schema } from "mongoose"

const changeSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    seq: { type: Number, required: true, min: 1 },
    txn: { type: String, required: true },
    op: { type: String, required: true },
    path: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    value: { type: Schema.Types.Mixed, default: null },
    reason: { type: String, default: null },
    at: { type: Date, required: true },
    by: { type: String, required: true },
    step_id: { type: String, default: null }
  },
  { strict: true, minimize: false }
)

changeSchema.index({ projectId: 1, seq: 1 }, { unique: true })
changeSchema.index({ projectId: 1, txn: 1 })

export const Change = mongoose.model("Change", changeSchema)
