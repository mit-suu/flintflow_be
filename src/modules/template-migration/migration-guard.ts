/**
 * Rào ghi bản nháp khi một lần đổi mẫu đang chạy (`applying` / `reverting`) hoặc kẹt chờ khôi phục (`apply_failed`: Spine có thể đã đổi mà profile chưa): giữa lúc Spine đã đổi và profile chưa kịp ghi, một CR /
 * release / lệnh chat sẽ chụp version từ profile cũ + Spine mới (lẫn, lưu vĩnh viễn). Mọi đường ghi bản nháp của người dùng gọi hàm này;
 * đường ghi của chính lần đổi mẫu thì không.
 */
import { ApiError } from "../../shared/utils/api-error.js"
import { TemplateMigration } from "./template-migration.model.js"

export const MIGRATION_RUNNING = "TEMPLATE_MIGRATION_APPLYING"

export const assertNoMigrationRunning = async (projectId: string): Promise<void> => {
  const running = await TemplateMigration.findOne({ projectId, state: { $in: ["applying", "reverting", "apply_failed"] } }, { state: 1 }).lean()
  if (!running) return
  throw new ApiError(
    409,
    running.state === "apply_failed"
      ? "Lần đổi mẫu của dự án bị kẹt và đang chờ khôi phục từ snapshot (hoặc huỷ) nên tạm chưa ghi / phát hành được."
      : "Dự án đang đổi mẫu nên tạm chưa ghi / phát hành được. Thử lại sau khi lần đổi mẫu xong.",
    MIGRATION_RUNNING,
    { state: running.state }
  )
}
