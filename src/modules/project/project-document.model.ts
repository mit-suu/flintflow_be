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
    }
  },
  { timestamps: true }
)

projectDocumentSchema.index({ projectId: 1, createdAt: -1 })

export const ProjectDocument = mongoose.model<IProjectDocument>("ProjectDocument", projectDocumentSchema)
