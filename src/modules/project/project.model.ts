import mongoose, { Schema, Document } from "mongoose"

export type ProjectStatus = "active" | "inactive" | "archived"

export interface IProject extends Document {
  userId: mongoose.Types.ObjectId
  name: string
  domain?: string | null
  status: ProjectStatus
  currentStep: string
  progressPercent: number
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
      enum: ["active", "inactive", "archived"],
      default: "active"
    },
    currentStep: {
      type: String,
      default: "step_1"
    },
    progressPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    }
  },
  { timestamps: true }
)

// Compound Index for dashboard list queries (UC06)
projectSchema.index({ userId: 1, status: 1 })

export const Project = mongoose.model<IProject>("Project", projectSchema)
