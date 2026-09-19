/**
 * Liên kết Spine ↔ block tài liệu (mode 1): phần tử Spine nào được trích từ block nào. FLF-171, plan §5.2.
 * Tách khỏi Spine để không đổi hợp đồng `spineSchema` (T01). Dùng ở C-3: `impactOf` ⇒ path ⇒ anchor ⇒ block.
 * `block_id` ổn định qua version nên anchor không gắn với version.
 */

import mongoose, { Schema, Document } from "mongoose"

export interface IFieldAnchor extends Document {
  projectId: mongoose.Types.ObjectId
  /** Path chuẩn hoá theo khoá, vd `use_cases[id=UC-01]` hoặc `use_cases[id=UC-01].name`. */
  entity_path: string
  block_ids: string[]
}

const fieldAnchorSchema = new Schema<IFieldAnchor>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    entity_path: { type: String, required: true },
    block_ids: { type: [String], default: [] }
  },
  { timestamps: true }
)

fieldAnchorSchema.index({ projectId: 1, entity_path: 1 }, { unique: true })
// Tra ngược block → thực thể (xem tài liệu theo block, C-3 nguồn "mention")
fieldAnchorSchema.index({ projectId: 1, block_ids: 1 })

export const FieldAnchor = mongoose.model<IFieldAnchor>("FieldAnchor", fieldAnchorSchema)
