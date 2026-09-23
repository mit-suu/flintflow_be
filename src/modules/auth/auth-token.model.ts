import mongoose, { Schema, Document } from "mongoose"

/**
 * - `verify_email`, `reset_password`: OTP 6 số gửi qua email.
 * - `reset_password_grant`: vé cấp sau khi nhập đúng OTP quên mật khẩu, dùng một lần để đặt mật khẩu mới.
 */
export type TokenType = "verify_email" | "reset_password" | "reset_password_grant"

export interface IAuthToken extends Document {
  userId: mongoose.Types.ObjectId
  type: TokenType
  tokenHash: string
  expiresAt: Date
  usedAt?: Date | null
  /** Số lần nhập sai OTP (chỉ dùng cho verify_email). */
  attempts: number
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
      enum: ["verify_email", "reset_password", "reset_password_grant"],
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
    },
    attempts: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
)

authTokenSchema.index({ userId: 1, type: 1 })

export const AuthToken = mongoose.model<IAuthToken>("AuthToken", authTokenSchema)
