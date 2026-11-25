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
  /**
   * Org đang mở của phiên này (task-26, BPMN Flow 9.3 đổi org). Giữ ở Session để lượt refresh cấp lại
   * access token mang đúng orgId; null = chưa chọn org (tài khoản chưa onboarding).
   */
  activeOrgId?: mongoose.Types.ObjectId | null
  userAgent?: string
  ip?: string
  /**
   * FLF-475: id của phiên gốc lúc đăng nhập (họ phiên). Phiên xoay ra kế thừa `familyId` của phiên cũ;
   * dùng để phân biệt reuse "thật" (thu hồi cả họ) với reuse do phản hồi bị mất / request song song
   * (chỉ xoay tiếp trong họ). `null`/thiếu ⇒ phiên tạo trước bản sửa này, không migrate — giữ hành vi cũ
   * (thu hồi mọi phiên của user khi gặp reuse ở phiên đó).
   */
  familyId?: mongoose.Types.ObjectId | null
  /** FLF-475: lúc phiên này bị XOAY (khác thu hồi do đăng xuất/đổi mật khẩu/logout-all). `null` = chưa xoay. */
  rotatedAt?: Date | null
  /** FLF-475: phiên mới sinh ra từ lần xoay này (nếu `rotatedAt` có). */
  replacedBy?: mongoose.Types.ObjectId | null
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
    activeOrgId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null
    },
    userAgent: {
      type: String
    },
    ip: {
      type: String
    },
    familyId: {
      type: Schema.Types.ObjectId,
      default: null,
      index: true
    },
    rotatedAt: {
      type: Date,
      default: null
    },
    replacedBy: {
      type: Schema.Types.ObjectId,
      default: null
    }
  },
  { timestamps: true }
)

export const Session = mongoose.model<ISession>("Session", sessionSchema)
