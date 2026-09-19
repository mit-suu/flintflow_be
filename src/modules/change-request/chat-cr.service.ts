/**
 * 3.1 từ chat (mode 1 v2 — FLF-186, plan v2 §8, D3): sau baseline v1, lệnh sửa trong chat tạo ngay một CR nguồn `chat`
 * (người yêu cầu = người gửi, mô tả = câu lệnh) thay cho việc bắt người dùng điền form. Chat trả lại
 * `409 CHANGE_REQUIRES_CR` kèm `meta.change_request` để FE hiện thẻ CR; C-2… chạy tiếp ở CR workspace.
 */

import { changeRequiresCr, prefillFrom } from "../import/mode1-guard.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { User } from "../user/user.model.js"
import { createCr } from "./change-request.service.js"

export const crFromChat = async (projectId: string, userId: string, chatId: string, instruction: string): Promise<Mode1Error> => {
  const prefill = prefillFrom(instruction)
  const user = (await User.findById(userId, { name: 1, email: 1 }).lean()) as { name?: string; email?: string } | null
  try {
    const cr = await createCr(projectId, userId, {
      title: prefill.title,
      description: prefill.description.slice(0, 5000),
      source: { kind: "chat", ref: `chat:${chatId}`, note: null },
      requester: user?.name?.trim() || user?.email || "Người dùng"
    })
    return changeRequiresCr(prefill, { cr_id: cr.cr_id, status: cr.status })
  } catch (err) {
    // Chưa có bản import (dữ liệu cũ / lỗi) ⇒ không tạo được CR, FE mở form điền sẵn như trước
    if (err instanceof Mode1Error && err.code === "CR_REQUIRES_BASELINE") return changeRequiresCr(prefill)
    throw err
  }
}
