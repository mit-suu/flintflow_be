import mongoose, { Schema, Document } from "mongoose"

export type PaymentIntentStatus = "pending" | "succeeded" | "failed"

export interface IPaymentIntent extends Document {
  userId: mongoose.Types.ObjectId
  packageId: string
  credits: number
  amount: number
  currency: string
  provider: "payment_service"
  status: PaymentIntentStatus
  /** order_id do payment_service sinh — khoá đối chiếu callback */
  paymentOrderId?: string | null
  referenceCode?: string | null
  /** Nội dung chuyển khoản, hiển thị nguyên văn (không tự sửa) */
  paymentDescription?: string | null
  qrCodeUrl?: string | null
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
      enum: ["payment_service"],
      default: "payment_service"
    },
    status: {
      type: String,
      enum: ["pending", "succeeded", "failed"],
      default: "pending"
    },
    paymentOrderId: {
      type: String,
      default: null
    },
    referenceCode: {
      type: String,
      default: null
    },
    paymentDescription: {
      type: String,
      default: null
    },
    qrCodeUrl: {
      type: String,
      default: null
    },
    processedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
)

paymentIntentSchema.index({ userId: 1, createdAt: -1 })
// Unique chỉ trên intent đã có order (intent tạo order lỗi giữ paymentOrderId = null)
paymentIntentSchema.index(
  { paymentOrderId: 1 },
  { unique: true, partialFilterExpression: { paymentOrderId: { $type: "string" } } }
)

export const PaymentIntent = mongoose.model<IPaymentIntent>("PaymentIntent", paymentIntentSchema)
