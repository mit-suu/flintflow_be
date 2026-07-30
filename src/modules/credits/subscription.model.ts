import mongoose, { Schema, Document } from "mongoose"

export type SubscriptionPlan = "free" | "pro"
export type SubscriptionStatus = "active" | "canceled" | "expired"

export interface ISubscription extends Document {
  userId: mongoose.Types.ObjectId
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
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true
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

export const Subscription = mongoose.model<ISubscription>("Subscription", subscriptionSchema)
