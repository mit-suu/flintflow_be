import mongoose, { Schema, Document } from "mongoose"

export const ORG_NAME_MAX = 80

/**
 * Tổ chức (UC-07). Mô hình "kiểu Supabase" (`context/business-flow.md` §2): ai cũng thuộc ít nhất một org,
 * làm một mình = org 1 thành viên và người đó là Lead. Project, thư mục, ví credit và subscription đều
 * thuộc về org chứ không thuộc về user (chuyển trục ở Pha 4 của task-26).
 *
 * `ownerUserId` là người tạo — chỉ để truy vết và để migration tìm lại "personal org" của một user.
 * Nó KHÔNG phải nguồn sự thật về quyền: quyền nằm ở `Membership.role`, và một org có nhiều Lead (BR-02).
 */
export interface IOrganization extends Document {
  name: string
  ownerUserId: mongoose.Types.ObjectId
  /**
   * Tăng 1 mỗi lần danh sách thành viên đổi. KHÔNG phải để hiển thị — nó là điểm ghi chung để hai
   * transaction đổi thành viên của cùng org đụng nhau: Mongo báo WriteConflict và chỉ một cái đi tiếp.
   * Thiếu nó, hai request hạ hai Lead cuối cùng chạy song song đều đếm thấy 2 Lead và org mất sạch Lead
   * (BR-02 thủng). Xem lead-succession.ts.
   */
  membershipVersion: number
  createdAt: Date
  updatedAt: Date
}

const organizationSchema = new Schema<IOrganization>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: ORG_NAME_MAX
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    membershipVersion: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
)

export const Organization = mongoose.model<IOrganization>("Organization", organizationSchema)
