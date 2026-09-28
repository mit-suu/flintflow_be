/**
 * step-runner.errors.ts
 * ─────────────────────────────────────────────────────────────────
 * Mã lỗi dùng chung của step runner, tách riêng để `run-state.service.ts` (khoá step) không phải import
 * `step-runner.service.ts` — vòng import ngược lại đã có sẵn.
 */

export const NOT_PIPELINE_SESSION = "NOT_PIPELINE_SESSION"
export const STEP_NOT_RUNNABLE = "STEP_NOT_RUNNABLE"
export const CALL_LIMIT = "CALL_LIMIT"

/**
 * Lý do abort khi user bấm Huỷ (`POST /cancel`). Đóng kết nối (reload, rớt mạng) abort KHÔNG kèm lý do này —
 * lượt đang chờ trả lời phân biệt hai trường hợp: huỷ thì dừng hẳn, đóng kết nối thì tách lượt.
 */
export const RUN_CANCELLED_REASON = "run_cancelled"

/**
 * Lượt chờ trả lời mất người nghe (đóng kết nối, hết giờ chờ): không phải lỗi — step vẫn `in_progress`,
 * run-state giữ `waiting_answer` + `pending_answer`, `/answer` chạy tiếp sau đó. Chỉ runner bắt lỗi này.
 */
export class AnswerDetached extends Error {
  constructor(readonly unit: string) {
    super(`Lượt chờ trả lời của ${unit} đã tách khỏi kết nối`)
    this.name = "AnswerDetached"
  }
}
