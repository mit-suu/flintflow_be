import mongoose from "mongoose"
import { env } from "../../config/env.js"
import { AiActionPayload } from "../../modules/admin/ai-action-payload.model.js"

/**
 * Lưu prompt + câu trả lời gốc của một lượt gọi model, để sau còn đọc lại được khi sửa chất lượng prompt.
 *
 * Trước đây `aiactionlogs` chỉ có token/latency, nên muốn biết model đã viết gì thì phải mò ngược từ
 * `stepruns.gate_payload` — mà payload đó bị xoá khi user duyệt, nên đúng những lượt đã chạy xong lại là
 * những lượt không còn đọc được.
 *
 * Giữ có hạn (`AI_PAYLOAD_RETENTION_DAYS`, mặc định 30 ngày) vì prompt mang nguyên văn điều người dùng
 * nhập; đặt `AI_PAYLOAD_RETENTION_DAYS=0` là tắt hẳn việc lưu.
 */

/** Cắt giữa, giữ đầu và cuối: đầu là luật của skill, cuối là projection và câu trả lời của user — bỏ bên nào cũng mất nửa manh mối. */
export const clipPayload = (text: string, max: number): string => {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n…[cắt ${text.length - max} ký tự]…\n${text.slice(text.length - tail)}`
}

export interface CapturePayloadInput {
  logId: string
  projectId?: string | undefined
  userId: string
  actionType: string
  prompt: string
  /** Chữ thô model trả về; `null` khi lượt chạy chết trước lúc model trả chữ nào. */
  response?: string | null
}

export const isPayloadCaptureEnabled = (): boolean => env.AI_PAYLOAD_RETENTION_DAYS > 0

/**
 * Ghi payload. **Không bao giờ ném** — lượt gọi model đã thành công thì không được đổ vì ghi log phụ thất bại
 * (cùng lý do credit đã trừ không được hoàn vì lỗi log).
 */
export const capturePayload = async (input: CapturePayloadInput): Promise<void> => {
  if (!isPayloadCaptureEnabled()) return
  const max = env.AI_PAYLOAD_MAX_CHARS
  try {
    await AiActionPayload.create({
      logId: new mongoose.Types.ObjectId(input.logId),
      projectId: input.projectId ? new mongoose.Types.ObjectId(input.projectId) : null,
      userId: new mongoose.Types.ObjectId(input.userId),
      actionType: input.actionType,
      prompt: clipPayload(input.prompt, max),
      response: input.response === null || input.response === undefined ? null : clipPayload(input.response, max),
      promptChars: input.prompt.length,
      responseChars: input.response?.length ?? 0
    })
  } catch (err) {
    console.error(`[capturePayload] Không lưu được prompt/response của log ${input.logId}:`, err)
  }
}
