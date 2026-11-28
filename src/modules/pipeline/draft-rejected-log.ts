/**
 * FLF-477 (B): lô soạn bị từ chối sau mọi lượt thử phải để lại dấu vết từng lượt (luật nào, path nào trượt).
 * Một dòng JSON ở log BE + đánh dấu `AiActionLog` của từng lượt (`retried` cho lượt trước, `failed` cho lượt cuối).
 * Câu báo cho người dùng không đổi; lỗi ghi log không được che lỗi gốc.
 */
import { AiActionLog } from "../admin/ai-action-log.model.js"
import { DraftRejectedError } from "./draft-to-ops.js"

const ERROR_MESSAGE_LIMIT = 1000

export interface DraftRejectedContext {
  projectId: string
  stepId: string
  callKind: string
}

export const recordDraftRejected = async (err: unknown, context: DraftRejectedContext): Promise<void> => {
  if (!(err instanceof DraftRejectedError)) return
  try {
    console.error("[draft-rejected]", JSON.stringify({ ...context, attempts: err.summary() }))
    const lastAttempt = err.attempts[err.attempts.length - 1]?.attempt
    for (const u of err.usage) {
      if (!u.logId) continue
      const attempt = err.attempts.find((a) => a.attempt === u.attempt)
      const errorMessage = (attempt?.errors ?? [])
        .map((e) => (e.path ? `${e.rule} @ ${e.path}` : e.rule))
        .join("; ")
        .slice(0, ERROR_MESSAGE_LIMIT)
      await AiActionLog.updateOne({ _id: u.logId }, { $set: { status: u.attempt === lastAttempt ? "failed" : "retried", errorMessage } })
    }
  } catch (logErr) {
    console.warn("[draft-rejected] không ghi được log lượt bị từ chối", logErr)
  }
}
