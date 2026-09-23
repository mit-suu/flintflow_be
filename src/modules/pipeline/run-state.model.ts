/**
 * run-state.model.ts
 * ─────────────────────────────────────────────────────────────────
 * Một dòng cho MỘT lượt chạy step (`step_runs`) — FLF-177 fix-plan WP-4 (BUG-05, BUG-07) và
 * `03-live-status-flow.md` §5.
 *
 * Trước đây khoá step là một `Set` trong bộ nhớ tiến trình: SSE đóng giữa lúc model đang soạn thì khoá
 * chỉ được nhả khi lượt gọi kết thúc (tới 15–20 phút), và reload làm mất sạch gate/câu hỏi đang mở.
 * Dòng này thay cả hai vai:
 *  - **khoá có hạn**: `locked_until` được gia hạn mỗi nhịp heartbeat; quá hạn ⇒ lượt khác chiếm lại được;
 *  - **trạng thái khôi phục được**: `stage`, `questions`, `gate_payload` để FE dựng lại đúng chỗ sau reload.
 *
 * Một step chỉ có một dòng (unique `projectId + step_id`), ghi đè mỗi lượt chạy mới.
 */

import mongoose, { Schema } from "mongoose"

export const RUN_STATUSES = ["running", "waiting_answer", "gate", "done", "interrupted", "cancelled"] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const RUN_STAGES = ["intake", "ask", "draft", "check", "render", "gate"] as const
export type RunStage = (typeof RUN_STAGES)[number]

const runStateSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    step_id: { type: String, required: true },
    /** Id lượt chạy — FE và endpoint `/cancel` dùng để chắc chắn đang nói về đúng lượt. */
    run_id: { type: String, required: true },
    session_id: { type: String, default: null },
    by: { type: String, default: null },
    status: { type: String, enum: RUN_STATUSES, required: true },
    stage: { type: String, enum: RUN_STAGES, required: true },
    /** Câu tiếng Việt mô tả việc đang làm ("Đang soạn chi tiết chức năng · lô 1/2"). */
    detail_vi: { type: String, default: null },
    batch: { type: Schema.Types.Mixed, default: null },
    started_at: { type: Date, required: true },
    last_event_at: { type: Date, required: true },
    /** Khoá còn hiệu lực tới lúc này; quá hạn ⇒ lượt mới được chiếm. */
    locked_until: { type: Date, required: true },
    /** Câu hỏi đang chờ trả lời (status `waiting_answer`). */
    questions: { type: Schema.Types.Mixed, default: null },
    /** Payload `gate_ready` để dựng lại GateCard sau reload (status `gate`). */
    gate_payload: { type: Schema.Types.Mixed, default: null },
    /** Sự kiện đã phát trong lượt (rút gọn) — để dựng lại nhật ký bước sau reload. */
    events: { type: Schema.Types.Mixed, default: [] },
    error: { type: Schema.Types.Mixed, default: null }
  },
  { timestamps: true, strict: true, minimize: false }
)

runStateSchema.index({ projectId: 1, step_id: 1 }, { unique: true })
runStateSchema.index({ projectId: 1, status: 1 })

export const StepRun = mongoose.model("StepRun", runStateSchema)
