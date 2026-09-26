import mongoose, { Schema, Document } from "mongoose"
import { ORG_ROLES, type OrgRole } from "./membership.model.js"

/**
 * UC-08 chỉ cho mời với vai trò Analyst hoặc Viewer. Muốn có thêm Lead thì mời trước rồi nâng vai trò
 * qua UC-73 — như vậy việc tạo Lead luôn là một hành động có chủ đích của một Lead đang có, không phải
 * hệ quả của một mã mời phát đi từ lâu.
 */
export const INVITABLE_ROLES = ORG_ROLES.filter((role): role is Exclude<OrgRole, "lead"> => role !== "lead")
export type InvitableRole = Exclude<OrgRole, "lead">

/**
 * Mã mời vào org (UC-08 tạo + thu hồi, UC-09 nhập mã).
 *
 * Chỉ lưu `codeHash` (sha256), không lưu mã thô: lộ DB không lộ mã đang còn hạn. Mã thô chỉ tồn tại
 * trong email gửi đi và trong response của đúng lượt tạo.
 *
 * Trạng thái suy ra từ các mốc thời gian, không lưu field `status` (giữ đúng luật "không lưu giá trị
 * suy diễn" của repo):
 *   revokedAt != null            → đã thu hồi
 *   acceptedAt != null           → đã dùng (mã dùng một lần)
 *   expiresAt <= now             → hết hạn
 *   còn lại                      → dùng được
 */
export interface IInvitation extends Document {
  organizationId: mongoose.Types.ObjectId
  /** Email người được mời — để hiển thị danh sách lời mời đang treo; null = mã dùng chung do Lead tự gửi. */
  email: string | null
  role: InvitableRole
  codeHash: string
  expiresAt: Date
  invitedByUserId: mongoose.Types.ObjectId
  acceptedByUserId: mongoose.Types.ObjectId | null
  acceptedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const invitationSchema = new Schema<IInvitation>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true
    },
    email: {
      type: String,
      default: null,
      lowercase: true,
      trim: true
    },
    role: {
      type: String,
      enum: INVITABLE_ROLES,
      required: true
    },
    codeHash: {
      type: String,
      required: true,
      unique: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    invitedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    acceptedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    acceptedAt: {
      type: Date,
      default: null
    },
    revokedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
)

// Danh sách lời mời của một org, mới nhất trước (UC-08).
invitationSchema.index({ organizationId: 1, createdAt: -1 })

export const Invitation = mongoose.model<IInvitation>("Invitation", invitationSchema)
