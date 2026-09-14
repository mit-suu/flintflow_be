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

export const Notification = mongoose.model<INotification>("Notification", notificationSchema)
