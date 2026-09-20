/**
 * Nhóm vị trí được duyệt/từ chối cùng nhau (nút 3.11–3.13, UC-51, UC-52). C-4 gom theo section / thực thể sở hữu.
 * Group bị từ chối mở khoá block ngay; tất cả bị từ chối ⇒ CR sửa lại (revise) hoặc đóng. FLF-171, plan §5.4.
 */

import mongoose, { Schema, Document } from "mongoose"
import { GROUP_DECISIONS, GROUP_ID_PATTERN, type GroupDecision } from "./change-request.constants.js"

export interface IChangeGroup extends Document {
  projectId: mongoose.Types.ObjectId
  cr_id: string
  group_id: string
  title: string
  location_ids: string[]
  decision: GroupDecision
  /** Bắt buộc khi từ chối. */
  reason: string | null
  decided_by: mongoose.Types.ObjectId | null
  decided_at: Date | null
}

const changeGroupSchema = new Schema<IChangeGroup>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    cr_id: { type: String, required: true },
    group_id: { type: String, required: true, match: GROUP_ID_PATTERN },
    title: { type: String, required: true },
    location_ids: { type: [String], default: [] },
    decision: { type: String, enum: GROUP_DECISIONS, default: "pending" },
    reason: { type: String, default: null },
    decided_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decided_at: { type: Date, default: null }
  },
  { timestamps: true }
)

changeGroupSchema.index({ projectId: 1, cr_id: 1, group_id: 1 }, { unique: true })

export const ChangeGroup = mongoose.model<IChangeGroup>("ChangeGroup", changeGroupSchema)
