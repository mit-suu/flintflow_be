import mongoose, { Schema, Document } from "mongoose"

export type ProjectStatus = "active" | "archived"

export interface IProject extends Document {
  userId: mongoose.Types.ObjectId
  name: string
  domain?: string | null
  status: ProjectStatus
  // Nội dung, tiến độ, baseline đều nằm ở Spine (modules/spine) — Project chỉ giữ metadata danh sách.
  createdAt: Date
  updatedAt: Date
}

const projectSchema = new Schema<IProject>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    domain: {
      type: String,
      default: null,
      trim: true
    },
    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active"
    }
  },
  { timestamps: true }
)

// Compound Index for dashboard list queries (UC06)
projectSchema.index({ userId: 1, status: 1 })

export const Project = mongoose.model<IProject>("Project", projectSchema)
