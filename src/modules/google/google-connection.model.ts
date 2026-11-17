import mongoose, { Schema, Document } from "mongoose"

/**
 * Một tài khoản Google đã cấp quyền `drive.file` cho một user FlintFlow (tối đa một bản ghi mỗi user).
 * Email Google ở đây có thể khác email đăng nhập — đây là luồng riêng, không phải `User.googleId`.
 *
 * `refreshTokenSealed` là refresh token đã mã hoá bằng `shared/crypto/secret-box.ts`; `select: false` để không lọt ra
 * response nào chỉ vì ai đó trả nguyên document.
 */
export interface IGoogleConnection extends Document {
  userId: mongoose.Types.ObjectId
  googleSub: string
  email: string
  refreshTokenSealed: string
  scopes: string[]
  connectedAt: Date
  /** Google từ chối refresh token (người dùng gỡ quyền, hết hạn 7 ngày ở chế độ Testing) ⇒ cần nối lại. */
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const googleConnectionSchema = new Schema<IGoogleConnection>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    googleSub: { type: String, required: true },
    email: { type: String, required: true },
    refreshTokenSealed: { type: String, required: true, select: false },
    scopes: { type: [String], default: [] },
    connectedAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null }
  },
  { timestamps: true }
)

export const GoogleConnection = mongoose.model<IGoogleConnection>("GoogleConnection", googleConnectionSchema)
