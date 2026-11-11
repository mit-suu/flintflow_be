/**
 * FLF-375 (business-flow §3.2 "Hai người sửa cùng lúc"): **không khoá** chỗ đang sửa — bảng khoá theo path (FLF-186) đã
 * bỏ; xác nhận (C-6) kiểm lại trên nội dung hiện tại (`concurrent-edit.ts`). Chỉ còn hàm dọn dòng khoá cũ của CR khi CR
 * đóng / ghi / bỏ vị trí, để collection `spinelocks` không giữ rác.
 */

import mongoose from "mongoose"
import { SpineLock } from "./spine-lock.model.js"

/** Dọn dòng khoá cũ của CR; không truyền `paths` ⇒ dọn hết. */
export const unlockPaths = async (projectId: string | mongoose.Types.ObjectId, crId: string, paths?: string[]): Promise<void> => {
  const filter: Record<string, unknown> = { projectId, cr_id: crId }
  if (paths) filter.path = { $in: paths }
  await SpineLock.deleteMany(filter)
}
