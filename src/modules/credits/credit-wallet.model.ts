import mongoose, { Schema, Document } from "mongoose"

export interface ICreditWallet extends Document {
  userId: mongoose.Types.ObjectId
  balance: number
  reserved: number
  createdAt: Date
  updatedAt: Date
}

const creditWalletSchema = new Schema<ICreditWallet>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true
    },
    balance: {
      type: Number,
      default: 0,
      min: 0
    },
    reserved: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  { timestamps: true }
)

export const CreditWallet = mongoose.model<ICreditWallet>("CreditWallet", creditWalletSchema)
