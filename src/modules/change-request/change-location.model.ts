/**
 * Một vị trí trong tài liệu bị CR ảnh hưởng (C-3 tìm, C-4 đề xuất, C-5 kiểm). FLF-171, plan §5.4.
 * Mọi vị trí phải có `conclusion` trước khi nộp. `redo_count` ≤ 2 (MAX_REDO_PER_LOCATION) rồi chuyển sửa tay.
 */

import mongoose, { Schema, Document } from "mongoose"
import {
  LOCATION_CONCLUSIONS,
  LOCATION_FOUND_BY,
  LOCATION_ID_PATTERN,
  type LocationConclusion,
  type LocationFoundBy
} from "./change-request.constants.js"
import { MAX_REDO_PER_LOCATION } from "./change-request.state.js"

export interface LocationProposal {
  /** Text block lúc đề xuất — C-5 so với block đang khoá, lệch ⇒ CR_OLD_TEXT_MISMATCH. */
  old_text: string
  new_text: string | null
  comment_text: string | null
  /** Op Spine đi kèm (định dạng `op.types.ts`), áp ở C-7 qua nhánh `post_baseline`. */
  spine_ops: unknown[]
}

export interface VerifyViolation {
  rule: string
  message: string
  path?: string
}

export interface LocationVerify {
  /** Kiểm tất định: old text khớp, op qua planTransaction chạy khô + bất biến, không thêm cờ đỏ. */
  code_ok: boolean
  violations: VerifyViolation[]
  /** Nhận xét AI consistency — chỉ vàng, không chặn. */
  ai_flags: { rule: string; message: string }[]
  at: Date
}

export interface IChangeLocation extends Document {
  projectId: mongoose.Types.ObjectId
  cr_id: string
  location_id: string
  block_id: string
  found_by: LocationFoundBy[]
  entity_paths: string[]
  /** Step sở hữu field ở vị trí này (nạp skill nội dung cho C-4); `null` nếu văn xuôi không gắn field. */
  owner_step: string | null
  conclusion: LocationConclusion | null
  reason: string | null
  proposal: LocationProposal | null
  /** User sửa tay (PATCH locations) — AI không đè lên. */
  manual: boolean
  redo_count: number
  verify: LocationVerify | null
  group_id: string | null
}

const opts = { _id: false }

const changeLocationSchema = new Schema<IChangeLocation>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    cr_id: { type: String, required: true },
    location_id: { type: String, required: true, match: LOCATION_ID_PATTERN },
    block_id: { type: String, required: true },
    found_by: { type: [{ type: String, enum: LOCATION_FOUND_BY }], default: [] },
    entity_paths: { type: [String], default: [] },
    owner_step: { type: String, default: null },
    conclusion: { type: String, enum: [...LOCATION_CONCLUSIONS, null], default: null },
    reason: { type: String, default: null },
    proposal: {
      type: new Schema(
        {
          old_text: { type: String, required: true },
          new_text: { type: String, default: null },
          comment_text: { type: String, default: null },
          spine_ops: { type: [Schema.Types.Mixed], default: [] }
        },
        opts
      ),
      default: null
    },
    manual: { type: Boolean, default: false },
    redo_count: { type: Number, default: 0, min: 0, max: MAX_REDO_PER_LOCATION },
    verify: {
      type: new Schema(
        {
          code_ok: { type: Boolean, required: true },
          violations: { type: [new Schema({ rule: String, message: String, path: String }, opts)], default: [] },
          ai_flags: { type: [new Schema({ rule: String, message: String }, opts)], default: [] },
          at: { type: Date, required: true }
        },
        opts
      ),
      default: null
    },
    group_id: { type: String, default: null }
  },
  { timestamps: true, minimize: false }
)

changeLocationSchema.index({ projectId: 1, cr_id: 1, location_id: 1 }, { unique: true })
// Một block chỉ xuất hiện một lần trong một CR
changeLocationSchema.index({ projectId: 1, cr_id: 1, block_id: 1 }, { unique: true })

export const ChangeLocation = mongoose.model<IChangeLocation>("ChangeLocation", changeLocationSchema)
