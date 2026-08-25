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
  isActive: boolean
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
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
)

// Compound Index for fetching active chat session (UC09)
chatSessionSchema.index({ projectId: 1, isActive: 1 })

export const ChatSession = mongoose.model<IChatSession>("ChatSession", chatSessionSchema)
