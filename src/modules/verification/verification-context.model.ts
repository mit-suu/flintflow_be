import mongoose, { Schema, Document } from "mongoose"

export type ReadinessStatus = "BLOCKED" | "NEEDS_CLARIFICATION" | "READY_TO_BUILD"

export interface IVerificationContext extends Document {
  projectId: mongoose.Types.ObjectId
  hiddenAssumptions: any[]
  missingInfo: any[]
  conflicts: any[]
  ambiguities: any[]
  followUpQuestions: any[]
  readinessScore?: number | null
  readinessStatus: ReadinessStatus
  lastComputedAt: Date
  createdAt: Date
  updatedAt: Date
}

const verificationContextSchema = new Schema<IVerificationContext>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      unique: true,
      index: true
    },
    hiddenAssumptions: [Schema.Types.Mixed],
    missingInfo: [Schema.Types.Mixed],
    conflicts: [Schema.Types.Mixed],
    ambiguities: [Schema.Types.Mixed],
    followUpQuestions: [Schema.Types.Mixed],
    readinessScore: {
      type: Number,
      default: null
    },
    readinessStatus: {
      type: String,
      enum: ["BLOCKED", "NEEDS_CLARIFICATION", "READY_TO_BUILD"],
      default: "NEEDS_CLARIFICATION"
    },
    lastComputedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
)

export const VerificationContext = mongoose.model<IVerificationContext>(
  "VerificationContext",
  verificationContextSchema
)
