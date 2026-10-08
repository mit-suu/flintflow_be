import mongoose, { Schema, Document } from "mongoose"

export type CreditTransactionType =
  | "reserve"
  | "deduct"
  | "release"
  | "refund"
  | "monthly_reset"
  | "purchase"
  /** UC-68: Administrator cộng/trừ credit ví org, bắt buộc kèm lý do. */
  | "admin_adjust"

/**
 * Vòng đời của một dòng `reserve`. Chỉ dòng `reserve` mang state; dòng
 * deduct/release trỏ ngược về nó qua `reservationId`.
 *   reserved → deducted  (AI chạy + parse thành công)
 *   reserved → refunded  (AI lỗi, release)
 *   reserved → expired   (quá expires_at, cron dọn)
 */
export type CreditReservationState = "reserved" | "deducted" | "refunded" | "expired"

export interface ICreditTransaction extends Document {
  userId: mongoose.Types.ObjectId
  /** Org sở hữu ví bị trừ (task-26). null = giao dịch có trước org, chờ migration backfill. */
  organizationId: mongoose.Types.ObjectId | null
  projectId?: mongoose.Types.ObjectId | null
  actionType: string
  amount: number
  type: CreditTransactionType
  balanceAfter: number
  state?: CreditReservationState
  expires_at?: Date
  reservationId?: mongoose.Types.ObjectId | null
  /** Lý do điều chỉnh (UC-68). Chỉ dòng admin_adjust mới có. */
  reason?: string | null
  createdAt: Date
  updatedAt: Date
}

const creditTransactionSchema = new Schema<ICreditTransaction>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    /**
     * Org sở hữu (task-26 Pha 0). Nullable ở pha này để migration backfill dần và API cũ chạy y nguyên;
     * Pha 4 đổi filter sang organizationId rồi mới bỏ nullable.
     */
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null
    },
    actionType: {
      type: String,
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    type: {
      type: String,
      enum: ["reserve", "deduct", "release", "refund", "monthly_reset", "purchase", "admin_adjust"],
      required: true
    },
    balanceAfter: {
      type: Number,
      required: true
    },
    state: {
      type: String,
      enum: ["reserved", "deducted", "refunded", "expired"]
    },
    expires_at: {
      type: Date
    },
    reservationId: {
      type: Schema.Types.ObjectId,
      ref: "CreditTransaction",
      default: null
    },
    reason: {
      type: String,
      default: null,
      trim: true
    }
  },
  { timestamps: true }
)

// Compound Index for credit transaction history (UC76)
creditTransactionSchema.index({ userId: 1, createdAt: -1 })
// UC-79 xem lịch sử tiêu credit của cả org
creditTransactionSchema.index({ organizationId: 1, createdAt: -1 })
// Cron expireStaleReservations quét reservation treo
creditTransactionSchema.index({ type: 1, state: 1, expires_at: 1 })

export const CreditTransaction = mongoose.model<ICreditTransaction>(
  "CreditTransaction",
  creditTransactionSchema
)
