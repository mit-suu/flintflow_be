import mongoose, { Schema, Document } from "mongoose"

export interface IProjectDocument extends Document {
  projectId: mongoose.Types.ObjectId
  uploadedBy: mongoose.Types.ObjectId
  fileName: string
  originalName: string
  mimeType: string
  size: number
  cloudinaryPublicId: string
  url: string
  extension?: string | null
  // Document parsing fields (Task 2a)
  extractedText?: string | null
  parseStatus: "pending" | "success" | "failed"
  parseError?: string | null
  tokenCount?: number | null
  // AI summary fields (Task 2b)
  summary?: string | null
  summaryStatus: "pending" | "success" | "failed"
  /** Số tài liệu trong project (FLF-292) — phần `D<n>` của mã đoạn `D1-P03`; gán một lần, không đổi khi xoá tài liệu khác. */
  docCode?: number | null
  createdAt: Date
  updatedAt: Date
}

const projectDocumentSchema = new Schema<IProjectDocument>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true
    },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    fileName: {
      type: String,
      required: true,
      trim: true
    },
    originalName: {
      type: String,
      required: true,
      trim: true
    },
    mimeType: {
      type: String,
      required: true,
      trim: true
    },
    size: {
      type: Number,
      required: true,
      min: 0
    },
    cloudinaryPublicId: {
      type: String,
      required: true,
      trim: true
    },
    url: {
      type: String,
      required: true,
      trim: true
    },
    extension: {
      type: String,
      default: null,
      trim: true
    },
    // Document parsing fields (Task 2a)
    extractedText: {
      type: String,
      default: null
    },
    parseStatus: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "pending"
    },
    parseError: {
      type: String,
      default: null
    },
    tokenCount: {
      type: Number,
      default: null
    },
    // AI summary fields (Task 2b)
    summary: {
      type: String,
      default: null
    },
    summaryStatus: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "pending"
    },
    docCode: {
      type: Number,
      default: null,
      min: 1
    }
  },
  { timestamps: true }
)

projectDocumentSchema.index({ projectId: 1, createdAt: -1 })

export const ProjectDocument = mongoose.model<IProjectDocument>("ProjectDocument", projectDocumentSchema)
