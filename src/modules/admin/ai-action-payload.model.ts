import mongoose, { Schema, Document } from "mongoose"
import { env } from "../../config/env.js"

/**
 * Prompt gửi đi và câu trả lời gốc của model cho một lượt gọi trong `aiactionlogs`.
 *
 * Để riêng collection thay vì thêm field vào `aiactionlogs` vì hai thứ có vòng đời khác nhau:
 *
 *  - Số liệu (token, latency, status) là dữ liệu vận hành, giữ lâu dài để dựng báo cáo chi phí.
 *  - Prompt chứa nguyên văn điều người dùng nhập, nên có hạn giữ. TTL của Mongo xoá cả document chứ không xoá
 *    được một field, nên để chung thì đặt TTL là mất luôn số liệu chi phí.
 *
 * Hạn giữ và mức cắt ngắn do `AI_PAYLOAD_RETENTION_DAYS` / `AI_PAYLOAD_MAX_CHARS` quyết. Chỉ admin đọc được
 * (`GET /api/v1/admin/ai-logs/:logId/payload`).
 */
export interface IAiActionPayload extends Document {
  logId: mongoose.Types.ObjectId
  projectId?: mongoose.Types.ObjectId | null
  userId: mongoose.Types.ObjectId
  actionType: string
  /** Prompt đã nội suy, đúng chuỗi gửi cho provider — đã cắt theo `AI_PAYLOAD_MAX_CHARS`. */
  prompt: string
  /** Câu trả lời thô của model trước khi parse; `null` khi lượt chạy chết trước lúc model trả chữ nào. */
  response?: string | null
  /** Độ dài THẬT trước khi cắt — đọc log mà không biết mình đang xem bản cắt thì dễ kết luận sai. */
  promptChars: number
  responseChars: number
  createdAt: Date
  updatedAt: Date
}

const aiActionPayloadSchema = new Schema<IAiActionPayload>(
  {
    logId: {
      type: Schema.Types.ObjectId,
      ref: "AiActionLog",
      required: true,
      unique: true
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    actionType: {
      type: String,
      required: true
    },
    prompt: {
      type: String,
      required: true
    },
    response: {
      type: String,
      default: null
    },
    promptChars: {
      type: Number,
      required: true
    },
    responseChars: {
      type: Number,
      required: true
    }
  },
  { timestamps: true }
)

// Hết hạn giữ thì Mongo tự xoá; log số liệu tương ứng vẫn còn.
aiActionPayloadSchema.index({ createdAt: 1 }, { expireAfterSeconds: env.AI_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 })
aiActionPayloadSchema.index({ projectId: 1, createdAt: -1 })

export const AiActionPayload = mongoose.model<IAiActionPayload>("AiActionPayload", aiActionPayloadSchema)
