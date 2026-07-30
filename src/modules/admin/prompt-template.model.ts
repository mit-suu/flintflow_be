import mongoose, { Schema, Document } from "mongoose"

export interface IPromptTemplate extends Document {
  actionType: string
  template: string
  version: number
  isActive: boolean
  updatedBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const promptTemplateSchema = new Schema<IPromptTemplate>(
  {
    actionType: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    template: {
      type: String,
      required: true
    },
    version: {
      type: Number,
      default: 1
    },
    isActive: {
      type: Boolean,
      default: true
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    }
  },
  { timestamps: true }
)

// Compound Index for prompt template queries (UC83)
promptTemplateSchema.index({ actionType: 1, isActive: 1 })

export const PromptTemplate = mongoose.model<IPromptTemplate>(
  "PromptTemplate",
  promptTemplateSchema
)
