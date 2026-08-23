/**
 * Task 2d — RequirementSourceLink Model
 *
 * Lưu liên kết structured giữa nội dung section được sinh ra
 * và tài liệu nguồn làm căn cứ (uploaded documents).
 *
 * Không cần parse lại text sau này — đủ data để build UI traceability table.
 */

import mongoose, { Schema, Document } from "mongoose"

export interface IRequirementSourceLink extends Document {
  projectId: mongoose.Types.ObjectId   // FK → Project (để query theo project)
  sectionId: mongoose.Types.ObjectId   // FK → Section (section vừa được generate)
  documentId: mongoose.Types.ObjectId  // FK → ProjectDocument (tài liệu nguồn)
  sourceExcerpt: string                // đoạn trích từ document làm căn cứ
  createdAt: Date
  updatedAt: Date
}

const requirementSourceLinkSchema = new Schema<IRequirementSourceLink>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true
    },
    sectionId: {
      type: Schema.Types.ObjectId,
      ref: "Section",
      required: true,
      index: true
    },
    documentId: {
      type: Schema.Types.ObjectId,
      ref: "ProjectDocument",
      required: true,
      index: true
    },
    sourceExcerpt: {
      type: String,
      required: true,
      trim: true
    }
  },
  { timestamps: true }
)

// Compound index để query nhanh: "tất cả source links của section X trong project Y"
requirementSourceLinkSchema.index({ projectId: 1, sectionId: 1 })

export const RequirementSourceLink = mongoose.model<IRequirementSourceLink>(
  "RequirementSourceLink",
  requirementSourceLinkSchema
)
