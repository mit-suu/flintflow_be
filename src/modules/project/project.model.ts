import mongoose, { Schema, Document } from "mongoose"

export type ProjectStatus = "active" | "archived"

export interface IProject extends Document {
  userId: mongoose.Types.ObjectId
  name: string
  domain?: string | null
  status: ProjectStatus
  currentStep: string
  currentPhase: 2 | 3 | 4
  workspacePhase: "discovery" | "product_overview" | "functional_spec" | "nfr_appendix" | "export"
  baselineVersion?: string | null
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
      enum: ["active", "archived"],
      default: "active"
    },
    currentStep: {
      type: String,
      default: "phase_2"
    },
    currentPhase: {
      type: Number,
      enum: [2, 3, 4],
      default: 2
    },
    workspacePhase: {
      type: String,
      enum: ["discovery", "product_overview", "functional_spec", "nfr_appendix", "export"],
      default: "discovery"
    },
    baselineVersion: {
      type: String,
      default: null
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
