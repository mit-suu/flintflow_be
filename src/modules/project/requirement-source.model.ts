/**
 * Nguồn tài liệu của phần tử Spine (FLF-292): yêu cầu nào được viết từ đoạn nào của tài liệu user upload. Tách khỏi Spine
 * như `FieldAnchor` của mode 1 — không đổi hợp đồng `spineSchema`. Một dòng cho mỗi phần tử; lượt Draft sau của cùng phần
 * tử ghi đè (nguồn là của nội dung hiện tại, không phải lịch sử). Mã đoạn ổn định nhờ `docCode` (`document-paragraphs.ts`).
 */

import mongoose, { Schema, Document } from "mongoose"

export interface IRequirementSourceRef {
  document_id: mongoose.Types.ObjectId
  /** `D1-P03`. */
  para_id: string
  /** Chữ của đoạn lúc ghi — tài liệu bị xoá thì nguồn vẫn đọc được. */
  quote: string
}

export interface IRequirementSource extends Document {
  projectId: mongoose.Types.ObjectId
  /** Path chuẩn hoá tới phần tử: `functions[id=FN12]`, `nfrs[id=N03]`, `project.vision`. */
  entity_path: string
  refs: IRequirementSourceRef[]
  /** Bước đã viết phần tử từ các đoạn này. */
  step_id: string
  createdAt: Date
  updatedAt: Date
}

const refSchema = new Schema<IRequirementSourceRef>(
  {
    document_id: { type: Schema.Types.ObjectId, ref: "ProjectDocument", required: true },
    para_id: { type: String, required: true },
    quote: { type: String, required: true }
  },
  { _id: false }
)

const requirementSourceSchema = new Schema<IRequirementSource>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    entity_path: { type: String, required: true },
    refs: { type: [refSchema], default: [] },
    step_id: { type: String, required: true }
  },
  { timestamps: true }
)

requirementSourceSchema.index({ projectId: 1, entity_path: 1 }, { unique: true })

export const RequirementSource = mongoose.model<IRequirementSource>("RequirementSource", requirementSourceSchema)
