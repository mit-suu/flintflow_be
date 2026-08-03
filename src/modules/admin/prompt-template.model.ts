import mongoose, { Schema, Document } from "mongoose"

export interface IPromptTemplate extends Document {
  actionType: string
  template: string
  provider: "openai" | "anthropic" | "gemini" | string
  aiModel: string
  maxTokens: number
  temperature: number
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
      index: true
    },
    template: {
      type: String,
      required: true
    },
    provider: {
      type: String,
      enum: ["openai", "anthropic", "gemini", "mock"],
      default: "openai"
    },
    aiModel: {
      type: String,
      default: "gpt-4o-mini"
    },
    maxTokens: {
      type: Number,
      default: 2048
    },
    temperature: {
      type: Number,
      default: 0.7
    },
    version: {
      type: Number,
      default: 1
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    }
  },
  { timestamps: true }
)

promptTemplateSchema.index({ actionType: 1, version: 1 }, { unique: true })
promptTemplateSchema.index({ actionType: 1, isActive: 1 })

export const PromptTemplate = mongoose.model<IPromptTemplate>(
  "PromptTemplate",
  promptTemplateSchema
)
