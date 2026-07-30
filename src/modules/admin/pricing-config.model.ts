import mongoose, { Schema, Document } from "mongoose"

export interface IPricingConfig extends Document {
  actionCosts: Record<string, number>
  planLimits: Record<string, any>
  isActive: boolean
  updatedBy: mongoose.Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const pricingConfigSchema = new Schema<IPricingConfig>(
  {
    actionCosts: {
      type: Schema.Types.Mixed,
      required: true
    },
    planLimits: {
      type: Schema.Types.Mixed,
      required: true
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    }
  },
  { timestamps: true }
)

export const PricingConfig = mongoose.model<IPricingConfig>("PricingConfig", pricingConfigSchema)
