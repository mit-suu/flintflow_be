import mongoose, { Schema, Document } from "mongoose"

export type PaymentIntentStatus = "pending" | "succeeded" | "failed"

export interface IPaymentIntent extends Document {
  userId: mongoose.Types.ObjectId
  packageId: string
  credits: number
  amount: number
  currency: string
  provider: "mock"
  status: PaymentIntentStatus
  processedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

const paymentIntentSchema = new Schema<IPaymentIntent>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    packageId: {
      type: String,
      required: true
    },
    credits: {
      type: Number,
      required: true,
      min: 1
    },
    amount: {
      type: Number,
      required: true,
      min: 0
    },
    currency: {
      type: String,
      default: "VND"
    },
    provider: {
      type: String,
      enum: ["mock"],
      default: "mock"
    },
    status: {
      type: String,
      enum: ["pending", "succeeded", "failed"],
      default: "pending"
    },
    processedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
)

paymentIntentSchema.index({ userId: 1, createdAt: -1 })

export const PaymentIntent = mongoose.model<IPaymentIntent>("PaymentIntent", paymentIntentSchema)
