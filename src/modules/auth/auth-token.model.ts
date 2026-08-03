import mongoose, { Schema, Document } from "mongoose"

export type TokenType = "verify_email" | "reset_password"

export interface IAuthToken extends Document {
  userId: mongoose.Types.ObjectId
  type: TokenType
  tokenHash: string
  expiresAt: Date
  usedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

const authTokenSchema = new Schema<IAuthToken>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: ["verify_email", "reset_password"],
      required: true
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 } // MongoDB TTL index: automatically delete document when expiresAt is reached
    },
    usedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
)

authTokenSchema.index({ userId: 1, type: 1 })

export const AuthToken = mongoose.model<IAuthToken>("AuthToken", authTokenSchema)
