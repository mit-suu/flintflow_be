import mongoose, { Schema, Document } from "mongoose"

export interface ISession extends Document {
  userId: mongoose.Types.ObjectId
  tokenHash: string
  expiresAt: Date
  isRevoked: boolean
  /**
   * Ô "Ghi nhớ tài khoản" lúc đăng nhập: `true` ⇒ phiên 30 ngày, cookie bền; `false` ⇒ cookie phiên
   * (đóng trình duyệt là mất); `null` ⇒ mặc định cũ (Google login, phiên tạo trước khi có tính năng).
   */
  rememberMe?: boolean | null
  userAgent?: string
  ip?: string
  createdAt: Date
  updatedAt: Date
}

const sessionSchema = new Schema<ISession>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    isRevoked: {
      type: Boolean,
      default: false
    },
    rememberMe: {
      type: Boolean,
      default: null
    },
    userAgent: {
      type: String
    },
    ip: {
      type: String
    }
  },
  { timestamps: true }
)

export const Session = mongoose.model<ISession>("Session", sessionSchema)
