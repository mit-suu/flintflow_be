import mongoose, { Schema, Document } from "mongoose"

export type CreditTransactionType = "reserve" | "deduct" | "release" | "monthly_reset" | "purchase"

export interface ICreditTransaction extends Document {
  userId: mongoose.Types.ObjectId
  projectId?: mongoose.Types.ObjectId | null
  actionType: string
  amount: number
  type: CreditTransactionType
  balanceAfter: number
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
    }
  },
  { timestamps: true }
)

// Compound Index for credit transaction history (UC76)
creditTransactionSchema.index({ userId: 1, createdAt: -1 })

export const CreditTransaction = mongoose.model<ICreditTransaction>(
  "CreditTransaction",
  creditTransactionSchema
)
