import mongoose, { Schema, Document } from "mongoose"

export interface IFactVsAssumption {
  text: string
  type: "fact" | "assumption"
}

export interface ISectionVersion extends Document {
  sectionId: mongoose.Types.ObjectId
  versionNumber: number
  content: any
  diffSummary?: string | null
  changedFields?: string[] | null
  factVsAssumption?: IFactVsAssumption[] | null
  createdBy: "ai" | "user"
  createdAt: Date
  updatedAt: Date
}

const factVsAssumptionSchema = new Schema<IFactVsAssumption>(
  {
    text: {
      type: String,
      required: true
    },
    type: {
      type: String,
      enum: ["fact", "assumption"],
      required: true
    }
  },
  { _id: false }
)

const sectionVersionSchema = new Schema<ISectionVersion>(
  {
    sectionId: {
      type: Schema.Types.ObjectId,
      ref: "Section",
      required: true,
      index: true
    },
    versionNumber: {
      type: Number,
      required: true
    },
    content: {
      type: Schema.Types.Mixed,
      required: true
    },
    diffSummary: {
      type: String,
      default: null
    },
    changedFields: {
      type: [String],
      default: null
    },
    factVsAssumption: {
      type: [factVsAssumptionSchema],
      default: null
    },
    createdBy: {
      type: String,
      enum: ["ai", "user"],
      required: true
    }
  },
  { timestamps: true }
)

// Unique compound index for section versions
sectionVersionSchema.index({ sectionId: 1, versionNumber: 1 }, { unique: true })

export const SectionVersion = mongoose.model<ISectionVersion>("SectionVersion", sectionVersionSchema)
