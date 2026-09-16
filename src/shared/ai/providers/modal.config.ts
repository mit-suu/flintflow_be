/**
 * modal.config.ts (T24)
 * ─────────────────────────────────────────────────────────────────
 * Địa chỉ endpoint tương thích OpenAI đang phục vụ GLM.
 *
 * Trước T24 giá trị này có **default hardcode** là URL Modal cá nhân của một thành viên, lặp lại ở 4
 * chỗ (`env.ts`, `glm.provider.ts`, `ai-sdk.provider.ts` × 2). Hậu quả: quên set biến môi trường thì
 * service không báo lỗi mà lặng lẽ gọi sang endpoint của người khác — và endpoint đó không còn nữa thì
 * lỗi hiện ra dưới dạng timeout khó hiểu ở giữa pipeline.
 *
 * Giờ thiếu cấu hình là lỗi ồn ào, ngay tại lượt gọi đầu tiên.
 */
import { env } from "../../../config/env.js"
import { AiActionError } from "../ai-action.types.js"

export const MODAL_BASE_URL_MISSING = "AI_PROVIDER_NOT_CONFIGURED"

export const modalBaseUrl = (): string => {
  // `env` đóng băng lúc import nên đọc thêm `process.env` — cùng cách `glm.provider.ts` lấy
  // MODAL_PROXY_TOKEN_ID / MODAL_API_KEY, để test và script đặt được biến sau khi module đã nạp.
  const url = (env.MODAL_BASE_URL || process.env.MODAL_BASE_URL)?.trim()
  if (!url) {
    throw new AiActionError(
      500,
      "MODAL_BASE_URL chưa được cấu hình. Đặt endpoint tương thích OpenAI đang phục vụ GLM trong .env (xem .env.example).",
      MODAL_BASE_URL_MISSING
    )
  }
  return url
}
