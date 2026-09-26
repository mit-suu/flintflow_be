import mongoose, { Schema, Document } from "mongoose"

/**
 * Vai trò trong MỘT org (`context/business-flow.md` §2, bảng Vai trò). Khác hẳn `User.role`
 * (`user | admin`) — cái đó là vai trò hệ thống của Administrator nền tảng.
 *   lead    — duyệt baseline / change group, quản lý thành viên, mua credit, xoá project
 *   analyst — soạn nội dung SRS, gửi Lead duyệt; không mua credit
 *   viewer  — chỉ đọc, comment, tải baseline; không chạy step AI
 * Cùng một người có thể là Lead ở org này và Viewer ở org khác.
 */
export const ORG_ROLES = ["lead", "analyst", "viewer"] as const
export type OrgRole = (typeof ORG_ROLES)[number]

/** Một người trong một org. Đây là nguồn sự thật DUY NHẤT về quyền — RBAC nạp lại mỗi request, không cache. */
export interface IMembership extends Document {
  organizationId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  role: OrgRole
  joinedAt: Date
  createdAt: Date
  updatedAt: Date
}

const membershipSchema = new Schema<IMembership>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    role: {
      type: String,
      enum: ORG_ROLES,
      required: true
    },
    joinedAt: {
      type: Date,
      default: () => new Date()
    }
  },
  { timestamps: true }
)

// Một người chỉ có một vai trò trong một org — chặn cả trường hợp accept mã mời hai lần song song (UC-09).
membershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true })
// "Org của tôi" (UC-10 switch organization) + RBAC nạp membership mỗi request.
membershipSchema.index({ userId: 1 })
// Đếm Lead còn lại khi leave / demote / remove (BR-02).
membershipSchema.index({ organizationId: 1, role: 1 })

export const Membership = mongoose.model<IMembership>("Membership", membershipSchema)
