import mongoose, { Schema, Document } from "mongoose"

export type SubscriptionPlan = "free" | "pro"
export type SubscriptionStatus = "active" | "canceled" | "expired"

export interface ISubscription extends Document {
  userId: mongoose.Types.ObjectId
  /** Org sở hữu gói (task-26). null = gói có trước org, chờ migration backfill. */
  organizationId: mongoose.Types.ObjectId | null
  plan: SubscriptionPlan
  status: SubscriptionStatus
  monthlyCreditsAllotment: number
  currentPeriodStart: Date
  currentPeriodEnd: Date
  createdAt: Date
  updatedAt: Date
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    /**
     * task-26 Pha 4: KHÔNG còn unique. Trục sở hữu là organizationId (partial unique index bên dưới) —
     * một người ở nhiều org thì có nhiều gói. Field này giờ chỉ cho biết ví/gói sinh ra từ tài khoản nào.
     */
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    /**
     * Org sở hữu (task-26 Pha 0). Nullable ở pha này để migration backfill dần và API cũ chạy y nguyên;
     * Pha 4 đổi filter sang organizationId rồi mới bỏ nullable.
     *
     * KHÔNG đặt index: true ở đây — partial unique index bên dưới cũng có khoá { organizationId: 1 } nên
     * hai bên sinh trùng tên organizationId_1 và Mongo từ chối tạo.
     */
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null
    },
    plan: {
      type: String,
      enum: ["free", "pro"],
      default: "free"
    },
    status: {
      type: String,
      enum: ["active", "canceled", "expired"],
      default: "active"
    },
    monthlyCreditsAllotment: {
      type: Number,
      required: true
    },
    currentPeriodStart: {
      type: Date,
      required: true
    },
    currentPeriodEnd: {
      type: Date,
      required: true,
      index: true
    }
  },
  { timestamps: true }
)

// Mỗi org một gói (business-flow §2). Partial index: xem giải thích ở credit-wallet.model.ts.
subscriptionSchema.index(
  { organizationId: 1 },
  { unique: true, partialFilterExpression: { organizationId: { $type: "objectId" } } }
)

export const Subscription = mongoose.model<ISubscription>("Subscription", subscriptionSchema)
