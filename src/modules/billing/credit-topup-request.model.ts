/**
 * Yêu cầu nạp credit (FLF-332, business-flow §2 "Tài khoản & credit", BR-08): Analyst thiếu credit bấm **Báo Lead nạp**
 * ⇒ mọi Lead của org nhận thông báo; Lead nạp xong (webhook thanh toán / admin cộng) ⇒ người đã yêu cầu được báo,
 * step **không tự chạy** — người dùng bấm tiếp tục. Một yêu cầu `open` mỗi (org, user); nạp xong ⇒ `fulfilled`.
 */

import mongoose, { Schema, Document } from "mongoose"

export type CreditTopupRequestStatus = "open" | "fulfilled"

export interface ICreditTopupRequest extends Document {
  organizationId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  projectId: mongoose.Types.ObjectId | null
  /** Bước / việc đang dừng vì thiếu credit (nhãn tự do, vd `S-5.4@S03`, `C-4`, `I-4`). */
  step: string | null
  /** Số credit ước tính cần thêm (người dùng / FE điền, có thể null). */
  needed: number | null
  status: CreditTopupRequestStatus
  fulfilledAt: Date | null
  /** Số credit đã nạp vào ví khi đóng yêu cầu. */
  fulfilledCredits: number | null
  createdAt: Date
  updatedAt: Date
}

const creditTopupRequestSchema = new Schema<ICreditTopupRequest>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    step: { type: String, default: null },
    needed: { type: Number, default: null },
    status: { type: String, enum: ["open", "fulfilled"], default: "open", index: true },
    fulfilledAt: { type: Date, default: null },
    fulfilledCredits: { type: Number, default: null }
  },
  { timestamps: true }
)

creditTopupRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 })

export const CreditTopupRequest = mongoose.model<ICreditTopupRequest>("CreditTopupRequest", creditTopupRequestSchema)
