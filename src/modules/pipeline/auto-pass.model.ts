/**
 * auto-pass.model.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-337 "Chưa xem": sổ những thay đổi AI **tự qua** (bước im tự Accept; CR tự ghi vào bản nháp ở mức "Chỉ ở mốc chốt") kèm
 * ai đã mở xem. Sổ riêng ngoài Spine (không lưu giá trị suy diễn vào Spine — ticket mục 3): Spine `changes[]` đã ghi lần
 * accept như một lần Accept thường, đây chỉ là lớp "đã xem / chưa xem" theo từng người dùng để hiện trước cổng cứng đưa tài
 * liệu ra ngoài (gửi duyệt / ký baseline / gửi gói / phát hành). Không chặn gì — người dùng không bắt buộc xem hết.
 */

import mongoose, { Schema } from "mongoose"

export interface IAutoPass {
  projectId: mongoose.Types.ObjectId
  /** Id bước (`S-2.1`, `S-5.2@S03`) hoặc `C-6:<cr_id>` với CR tự ghi. */
  step_id: string
  /** Nhãn tiếng Việt lúc ghi (tên bước / "CR-001 tự ghi vào bản nháp") — để FE không phải tra registry cho CR. */
  label_vi: string
  reason_vi: string
  at: Date
  /** userId đã mở xem. */
  seen_by: string[]
}

const autoPassSchema = new Schema<IAutoPass>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    step_id: { type: String, required: true },
    label_vi: { type: String, required: true },
    reason_vi: { type: String, required: true },
    at: { type: Date, required: true },
    seen_by: { type: [String], default: [] }
  },
  { timestamps: false, strict: true, minimize: false }
)

autoPassSchema.index({ projectId: 1, at: -1 })

export const AutoPass = mongoose.model<IAutoPass>("AutoPass", autoPassSchema)
