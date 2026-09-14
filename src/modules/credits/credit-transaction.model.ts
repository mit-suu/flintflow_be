import mongoose, { Schema, Document } from "mongoose"

export type CreditTransactionType = "reserve" | "deduct" | "release" | "monthly_reset" | "purchase"

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
  projectId?: mongoose.Types.ObjectId | null
  actionType: string
  amount: number
  type: CreditTransactionType
  balanceAfter: number
  state?: CreditReservationState
  expires_at?: Date
  reservationId?: mongoose.Types.ObjectId | null
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
      enum: ["reserve", "deduct", "release", "monthly_reset", "purchase"],
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
    }
  },
  { timestamps: true }
)

// Compound Index for credit transaction history (UC76)
creditTransactionSchema.index({ userId: 1, createdAt: -1 })
// Cron expireStaleReservations quét reservation treo
creditTransactionSchema.index({ type: 1, state: 1, expires_at: 1 })

export const CreditTransaction = mongoose.model<ICreditTransaction>(
  "CreditTransaction",
  creditTransactionSchema
)
