import mongoose, { Schema, Document } from "mongoose"

export type AiActionLogStatus = "success" | "failed" | "retried"

export interface IAiActionLog extends Document {
  projectId?: mongoose.Types.ObjectId | null
  userId: mongoose.Types.ObjectId
  actionType: string
  provider: string
  aiModel: string
  status: AiActionLogStatus
  errorMessage?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  latencyMs?: number | null
  retryOfLogId?: mongoose.Types.ObjectId | null
  createdAt: Date
  updatedAt: Date
}

const aiActionLogSchema = new Schema<IAiActionLog>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    actionType: {
      type: String,
      required: true
    },
    provider: {
      type: String,
      required: true
    },
    aiModel: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ["success", "failed", "retried"],
      required: true,
      index: true
    },
    errorMessage: {
      type: String,
      default: null
    },
    promptTokens: {
      type: Number,
      default: null
    },
    completionTokens: {
      type: Number,
      default: null
    },
    latencyMs: {
      type: Number,
      default: null
    },
    retryOfLogId: {
      type: Schema.Types.ObjectId,
      ref: "AiActionLog",
      default: null
    }
  },
  { timestamps: true }
)

aiActionLogSchema.index({ projectId: 1, createdAt: -1 })
aiActionLogSchema.index({ userId: 1, createdAt: -1 })
// Admin metrics / ai-cost lọc theo khoảng thời gian toàn hệ thống (T06)
aiActionLogSchema.index({ createdAt: 1 })

export const AiActionLog = mongoose.model<IAiActionLog>("AiActionLog", aiActionLogSchema)
