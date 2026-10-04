import mongoose, { Schema, Document } from "mongoose"

export interface IChatMessage {
  role: "user" | "ai"
  content: string
  step?: string
  discoveryStep?: number
  createdAt: Date
}

export interface IChatSession extends Document {
  projectId: mongoose.Types.ObjectId
  messages: IChatMessage[]
  /** Session chạy pipeline (Elicit/Draft/Gate). Đúng một mỗi project — srs-spine.md §6 bất biến 7. */
  is_pipeline: boolean
  createdAt: Date
  updatedAt: Date
}

const chatMessageSchema = new Schema<IChatMessage>(
  {
    role: {
      type: String,
      enum: ["user", "ai"],
      required: true
    },
    content: {
      type: String,
      required: true
    },
    step: {
      type: String,
      default: "vision_problem"
    },
    discoveryStep: {
      type: Number,
      min: 1,
      max: 6
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
)

const chatSessionSchema = new Schema<IChatSession>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true
    },
    messages: [chatMessageSchema],
    is_pipeline: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
)

// FLF-244: bỏ field `isActive` và index `{projectId, isActive}` — không còn đọc. DB cũ có thể drop tay index
// `projectId_1_isActive_1` (Mongoose không tự xoá index), xem docs/ops.md.

// Bất biến 7: tối đa một session is_pipeline = true mỗi project
chatSessionSchema.index(
  { projectId: 1 },
  { unique: true, partialFilterExpression: { is_pipeline: true }, name: "uniq_pipeline_session_per_project" }
)

export const ChatSession = mongoose.model<IChatSession>("ChatSession", chatSessionSchema)
