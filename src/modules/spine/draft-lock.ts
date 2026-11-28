/**
 * Khoá draft khi đang chờ Lead duyệt (UC-45, UC-51 C-7, FLF-293).
 *
 * Analyst đã nộp bản ở `baseline_submission.spine_version`; Lead duyệt đúng bản đó. Sửa nội dung trong lúc chờ
 * làm Lead ký một tài liệu khác bản được nộp ⇒ mọi đường sửa của user (`/changes`, `/changes/preview`,
 * `/reconcile`, `/undo`, sửa giả định) từ chối cho tới khi Lead duyệt hoặc từ chối (từ chối ⇒ `rejected`, mở khoá).
 * Ghi của hệ thống (ký baseline, từ chối, tính lại cờ) không đi qua đây.
 */

import type { Spine } from "./spine.types.js"
import * as spineRepository from "./spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const DRAFT_LOCKED = "DRAFT_LOCKED"

export const isDraftLocked = (spine: Pick<Spine, "baseline_submission">): boolean => spine.baseline_submission?.status === "pending"

export const assertDraftUnlocked = (spine: Pick<Spine, "baseline_submission"> | null | undefined): void => {
  if (spine && isDraftLocked(spine)) {
    throw new ApiError(409, "Tài liệu đang chờ Lead duyệt nên tạm khoá sửa. Chờ Lead duyệt hoặc từ chối rồi sửa tiếp.", DRAFT_LOCKED)
  }
}

/**
 * Bản nộp baseline 1.0 và gói duyệt sau baseline cùng nằm ở `baseline_submission` ⇒ một lần kiểm phủ cả hai trạng thái
 * chờ Lead (business-flow §2, C-7). Dùng ở các đường người dùng chạy step / cổng / mở lại step, trước khi giữ khoá lượt
 * chạy hay giữ credit, để bị từ chối thì không tốn gì.
 */
export const assertProjectUnlocked = async (projectId: string): Promise<void> => {
  assertDraftUnlocked(await spineRepository.get(projectId))
}
