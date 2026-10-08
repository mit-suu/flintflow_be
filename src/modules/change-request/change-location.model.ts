/**
 * Một vị trí bị CR ảnh hưởng (C-3 tìm, C-4 đề xuất, C-5 kiểm). Mode 1 v2 (FLF-186): vị trí = **phần tử Spine**
 * (`path`) + section hiển thị nó, thay block của file docx. Mọi vị trí phải có `conclusion` trước khi nộp.
 * `redo_count` ≤ 2 (MAX_REDO_PER_LOCATION) rồi chuyển sửa tay.
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
  /** Giá trị phần tử lúc đề xuất (`valueText`) — C-5/C-7 so với Spine hiện tại, lệch ⇒ CR_VALUE_CHANGED. */
  old_text: string
  /** Giá trị phần tử sau khi áp `spine_ops` của vị trí (chạy khô) — để người duyệt đọc; `null` khi không sửa. */
  new_text: string | null
  comment_text: string | null
  /** Op Spine (định dạng `op.types.ts`), áp ở C-7 sau khi duyệt. */
  spine_ops: unknown[]
  /** Mode 1 v3 phase 7: dữ kiện AI phải tự giả định (CR / câu trả lời / tài liệu không nói) — người duyệt cần xác nhận. */
  assumptions?: string[]
}

export interface VerifyViolation {
  rule: string
  message: string
  path?: string
}

export interface LocationVerify {
  /** Kiểm tất định: giá trị tại path chưa đổi, op chạm đúng phần tử đã khoá, chạy khô + bất biến, không thêm cờ đỏ. */
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
  /** Phần tử Spine: `project`, `actors[id=A01]`, `custom_sections[id=CS02]`… */
  path: string
  /** Section hiển thị phần tử (`fixed:2.1`, `function:FN01`, `custom:CS02`, `misc`). */
  section_id: string
  found_by: LocationFoundBy[]
  entity_paths: string[]
  /** Step sở hữu section (nạp skill nội dung cho C-4); `null` với mục riêng. */
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
    path: { type: String, required: true },
    section_id: { type: String, required: true },
    found_by: { type: [{ type: String, enum: LOCATION_FOUND_BY }], default: [] },
    entity_paths: { type: [String], default: [] },
    owner_step: { type: String, default: null },
    conclusion: { type: String, enum: [...LOCATION_CONCLUSIONS, null], default: null },
    reason: { type: String, default: null },
    proposal: {
      type: new Schema(
        {
          old_text: { type: String, default: "" },
          new_text: { type: String, default: null },
          comment_text: { type: String, default: null },
          spine_ops: { type: [Schema.Types.Mixed], default: [] },
          assumptions: { type: [String], default: [] }
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
// Một phần tử chỉ xuất hiện một lần trong một CR
changeLocationSchema.index({ projectId: 1, cr_id: 1, path: 1 }, { unique: true })

export const ChangeLocation = mongoose.model<IChangeLocation>("ChangeLocation", changeLocationSchema)
