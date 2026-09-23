/**
 * step-runner.errors.ts
 * ─────────────────────────────────────────────────────────────────
 * Mã lỗi dùng chung của step runner, tách riêng để `run-state.service.ts` (khoá step) không phải import
 * `step-runner.service.ts` — vòng import ngược lại đã có sẵn.
 */

export const NOT_PIPELINE_SESSION = "NOT_PIPELINE_SESSION"
export const STEP_NOT_RUNNABLE = "STEP_NOT_RUNNABLE"
export const CALL_LIMIT = "CALL_LIMIT"
