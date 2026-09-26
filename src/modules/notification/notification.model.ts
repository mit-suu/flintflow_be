import mongoose, { Schema, Document } from "mongoose"

/**
 * Loại notification vòng một. Để mở (string) vì gate/baseline (T13/T19) sẽ
 * phát thêm loại mới qua `notify` mà không phải sửa model.
 */
export type NotificationType =
  | "welcome"
  | "payment_success"
  | "payment_failed"
  | "low_credit"
  | "plan_changed"
  | "admin_new_user"
  | (string & {})

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId
  /**
   * Org mà thông báo thuộc về (task-26). Thông báo vẫn gửi cho NGƯỜI (userId) — thêm org để một người ở
   * nhiều org không thấy lẫn thông báo của org khác. null = thông báo cấp nền tảng (vd admin_new_user).
   */
  organizationId: mongoose.Types.ObjectId | null
  type: NotificationType
  title: string
  body: string
  link?: string | null
  readAt?: Date | null
  meta?: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

const notificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    /**
     * Org sở hữu (task-26 Pha 0). Nullable ở pha này để migration backfill dần và API cũ chạy y nguyên;
     * Pha 4 đổi filter sang organizationId rồi mới bỏ nullable.
     */
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true
    },
    type: {
      type: String,
      required: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    body: {
      type: String,
      default: ""
    },
    link: {
      type: String,
      default: null
    },
    readAt: {
      type: Date,
      default: null
    },
    meta: {
      type: Schema.Types.Mixed,
      default: null
    }
  },
  { timestamps: true }
)

// Danh sách + đếm chưa đọc theo user
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 })
// Cùng truy vấn nhưng lọc theo org đang mở
notificationSchema.index({ userId: 1, organizationId: 1, readAt: 1, createdAt: -1 })

export const Notification = mongoose.model<INotification>("Notification", notificationSchema)
