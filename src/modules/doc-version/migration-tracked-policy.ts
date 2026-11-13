/**
 * Bản Track Changes theo lần ghi có đổi mẫu (D11): chỉ hiện thay đổi nội dung. Lần ghi mang Change của đổi mẫu ⇒ so nội dung
 * (bỏ heading + chữ hướng dẫn); đổi mẫu có dịch ⇒ mọi đoạn đổi chữ, bản đánh dấu vô nghĩa ⇒ không tạo.
 * Lần đổi mẫu đã hoàn tác (`reverted`) không ảnh hưởng.
 */

import { TemplateMigration } from "../template-migration/template-migration.model.js"

export type TrackedPolicy = "normal" | "content_only" | "none"

/**
 * Chính sách cho một lần ghi so với version trước (`since` = thời điểm tạo version đó): xét **mọi** lần đổi mẫu đã áp dụng (chưa hoàn tác) sau mốc đó —
 * không có ⇒ `normal`; có một lần có dịch ⇒ `none`; còn lại ⇒ `content_only`. Dựa trên bản ghi đổi mẫu chứ không trên Change: lần đổi mẫu không ghi op nào
 * vẫn đổi heading + file nền.
 */
export const trackedPolicySince = async (projectId: string, since: Date): Promise<TrackedPolicy> => {
  const migrations = (await TemplateMigration.find({ projectId, state: "applied", applied_at: { $gt: since } }, { translated: 1 }).lean()) as { translated?: boolean }[]
  if (!migrations.length) return "normal"
  return migrations.some((m) => m.translated === true) ? "none" : "content_only"
}
