/**
 * 3.1 từ lệnh sửa (mode 1 v2 — FLF-186, plan v2 §8, D3): sau baseline v1, lệnh sửa tạo ngay một CR (người yêu cầu =
 * người gửi, mô tả = câu lệnh) thay cho việc bắt người dùng điền form. Trả `409 CHANGE_REQUIRES_CR` kèm
 * `meta.change_request` để FE mở thẳng CR; C-2… chạy tiếp ở CR workspace.
 * Dùng cho lệnh trong chat (nguồn `chat`) và cho `/changes`, `/undo` gọi thẳng từ workspace (nguồn `verbal` — nợ T8).
 */

import { changeRequiresCr, prefillFrom } from "../import/mode1-guard.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { User } from "../user/user.model.js"
import type { CrSourceKind } from "./change-request.constants.js"
import { createCr } from "./change-request.service.js"

interface CrFromInstructionOptions {
  kind: CrSourceKind
  ref?: string | null
  /** Tiêu đề + mô tả khi không có câu lệnh (ví dụ `/undo`). */
  fallback?: string
}

export const crFromInstruction = async (
  projectId: string,
  userId: string,
  instruction: string | undefined,
  { kind, ref = null, fallback }: CrFromInstructionOptions
): Promise<Mode1Error> => {
  const prefill = fallback ? prefillFrom(instruction, fallback) : prefillFrom(instruction)
  const user = (await User.findById(userId, { name: 1, email: 1 }).lean()) as { name?: string; email?: string } | null
  try {
    const cr = await createCr(projectId, userId, {
      title: prefill.title,
      description: prefill.description.slice(0, 5000),
      source: { kind, ref, note: null },
      requester: user?.name?.trim() || user?.email || "Người dùng"
    })
    return changeRequiresCr(prefill, { cr_id: cr.cr_id, status: cr.status })
  } catch (err) {
    // Chưa có bản import (dữ liệu cũ / lỗi) ⇒ không tạo được CR, FE mở form điền sẵn như trước
    if (err instanceof Mode1Error && err.code === "CR_REQUIRES_BASELINE") return changeRequiresCr(prefill)
    throw err
  }
}

export const crFromChat = (projectId: string, userId: string, chatId: string, instruction: string): Promise<Mode1Error> =>
  crFromInstruction(projectId, userId, instruction, { kind: "chat", ref: `chat:${chatId}` })
