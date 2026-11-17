import mongoose, { Schema, Document } from "mongoose"

export const PENDING_ACTION_TOOLS = ["replace_text", "insert_text"] as const
export type PendingActionTool = (typeof PENDING_ACTION_TOOLS)[number]

/** Đề xuất sửa hết hạn sau 1 giờ (Mongo TTL tự xoá; truy vấn cũng lọc `expiresAt` vì TTL chạy trễ tới ~1 phút). */
export const PENDING_ACTION_TTL_MS = 60 * 60 * 1000

/**
 * Một đề xuất sửa Google Doc do trợ lý tạo — tool ghi của agent chỉ chạy `dryRun: true` rồi lưu ở đây. Google Doc chỉ đổi
 * khi chính người dùng bấm Áp dụng (`POST …/agent/actions/:id/apply`), gửi kèm `revisionId` của lúc xem trước.
 */
export interface IGooglePendingAction extends Document {
  projectId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  documentId: string
  tool: PendingActionTool
  /** Tham số tool (không gồm `dryRun` / `expectedRevisionId`). */
  args: Record<string, unknown>
  /** Kết quả xem trước của tool (số chỗ khớp + mẫu, hoặc vị trí chèn + chữ). */
  preview: Record<string, unknown>
  revisionId: string
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

const pendingActionSchema = new Schema<IGooglePendingAction>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    documentId: { type: String, required: true },
    tool: { type: String, enum: PENDING_ACTION_TOOLS, required: true },
    args: { type: Schema.Types.Mixed, required: true },
    preview: { type: Schema.Types.Mixed, required: true },
    revisionId: { type: String, required: true },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true, minimize: false }
)

pendingActionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
pendingActionSchema.index({ projectId: 1, userId: 1 })

export const GooglePendingAction = mongoose.model<IGooglePendingAction>("GooglePendingAction", pendingActionSchema)
