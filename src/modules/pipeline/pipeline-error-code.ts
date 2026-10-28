/**
 * pipeline-error-code.ts
 * ─────────────────────────────────────────────────────────────────
 * Quy lỗi bắt được trong lượt chạy step / giai đoạn về mã của bảng pipeline (contract §0.3). Dùng chung cho sự kiện SSE
 * `error` (controller) và cho `error` ghi vào run-state (step-runner, phase-runner) — trước FLF-332 hai nơi quy khác nhau:
 * SSE nói `AI_PROVIDER_ERROR` còn run-state ghi `UNKNOWN` (AiActionError không kế thừa ApiError), nên mở lại trang không
 * còn biết lượt gãy vì AI hay vì gì khác.
 */

import { ApiError } from "../../shared/utils/api-error.js"
import { AiActionError } from "../../shared/ai/ai-action.types.js"
import { clientErrorMessage } from "../../shared/utils/client-error.js"
import { PIPELINE_ERROR_STATUS, type PipelineErrorCode } from "./pipeline.dto.js"

const isPipelineErrorCode = (code: string): code is PipelineErrorCode => code in PIPELINE_ERROR_STATUS

/**
 * F7: lỗi không thuộc bảng mã pipeline vẫn phải đóng luồng bằng một sự kiện `error` (không được im lặng
 * đóng) — quy về `VALIDATION_ERROR` nếu là lỗi 400 (đầu vào), còn lại quy về `NOT_IMPLEMENTED` (501, đúng
 * ngữ nghĩa "nhánh chưa hiện thực"/lỗi không rõ trong bảng contract §0.3).
 */
export const toPipelineErrorCode = (err: unknown): PipelineErrorCode => {
  // AiActionError (reserve credit, provider) không kế thừa ApiError nhưng cùng dạng {statusCode, code} — vd
  // INSUFFICIENT_CREDIT giữa chừng trước đây bị quy thành NOT_IMPLEMENTED (M3 2026-09-15).
  if (err instanceof ApiError || err instanceof AiActionError) {
    if (isPipelineErrorCode(err.code)) return err.code
    if (err.statusCode === 400) return "VALIDATION_ERROR"
    // Lỗi của nhà cung cấp AI có mã riêng (GLM_ERROR, GEMINI_ERROR, GLM_EMPTY_OUTPUT…) không nằm trong bảng
    // pipeline. Trước đây quy hết về NOT_IMPLEMENTED (501) nên người dùng đọc "chưa hiện thực" trong khi thật ra
    // endpoint AI hết hạn mức / chưa gắn thanh toán (gặp thật 2026-09-20).
    if (err.statusCode === 429) return "RATE_LIMIT_EXCEEDED"
    if (err instanceof AiActionError && err.statusCode >= 500) return "AI_PROVIDER_ERROR"
  }
  return "NOT_IMPLEMENTED"
}

/**
 * Mã lỗi "AI lỗi" (business-flow §2 "Lỗi khi gọi AI"): đã tự thử lại 2 lần, credit đã hoàn; người dùng chọn Thử lại ngay /
 * Để sau. Không gồm hết credit (402 — luồng nạp) hay lỗi dữ liệu (đầu vào, xung đột version).
 */
export const AI_ERROR_CODES: ReadonlySet<string> = new Set(["AI_PROVIDER_ERROR", "RATE_LIMIT_EXCEEDED", "AI_EXECUTION_FAILED", "PARSE_FAILED", "SCHEMA_MISMATCH"])

export const isAiErrorCode = (code: string | null | undefined): boolean => code != null && AI_ERROR_CODES.has(code)

/** `error` ghi vào run-state: cùng mã với sự kiện SSE, câu đã làm sạch cho người dùng (FLF-247). */
export const runErrorOf = (err: unknown): { code: string; message: string } => ({
  code: err instanceof ApiError ? err.code : err instanceof AiActionError ? toPipelineErrorCode(err) : "UNKNOWN",
  message: clientErrorMessage(err)
})
