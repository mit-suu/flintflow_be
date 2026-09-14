/**
 * Mongoose model Usage — một lượt gọi model (srs-spine.md §2 `usage[]`, Phases §4.2).
 * Dòng `reserved` có `expires_at` quá hạn sẽ được dọn (T04/T13).
 */

import mongoose, { Schema } from "mongoose"

const usageSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    step_id: { type: String, required: true },
    call_kind: { type: String, required: true },
    attempt: { type: Number, required: true, min: 1 },
    tokens_in: { type: Number, default: 0, min: 0 },
    tokens_out: { type: Number, default: 0, min: 0 },
    cost: { type: Number, default: 0, min: 0 },
    state: { type: String, enum: ["reserved", "deducted", "refunded"], required: true },
    expires_at: { type: Date, required: true },
    logId: { type: Schema.Types.ObjectId, ref: "AiActionLog", default: null }
  },
  { timestamps: true, strict: true }
)

usageSchema.index({ projectId: 1, step_id: 1 })
// Quét dòng reserved quá hạn để hoàn credit
usageSchema.index({ state: 1, expires_at: 1 })

export const Usage = mongoose.model("Usage", usageSchema)
