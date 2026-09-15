/**
 * meter.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Sổ `usage[]` theo step (srs-spine.md §2, `assets/skills/action/meter/SKILL.md`).
 *
 * Reserve/deduct/release thật ở VÍ đã do `shared/ai/credit-reservation.service.ts` (T04) làm bên trong
 * `executeAiAction`/`executeAiActionStream`: mỗi lượt gọi model reserve trước, deduct ngay sau khi parse
 * thành công, release khi lỗi. `draftOps` (T11) và `runElicit` (T13) đều đi qua đó, nên khi kết quả trả
 * về đây thì credit ở VÍ đã ở trạng thái cuối (deducted hoặc đã release nếu lỗi/không tới đây).
 *
 * `meter.service` ghi LẠI các lượt đã deduct thành công vào collection `usages` (usage.model.ts, T01) để:
 *  - đếm `calls_used`/`regenerate_used` mỗi step cho trần 8/3 (đọc, không lưu số đã tính — coding-rules §3.4).
 *  - phục vụ đo token (T14/T22).
 *
 * 409 SPINE_VERSION_CONFLICT xảy ra SAU khi model đã trả lời và credit đã deduct (draftOps chỉ trả
 * Transaction, `applyTransaction` mới chạm DB). Ở đây không có API "hoàn credit đã deduct" tại ví — xem
 * `refundRoundTrip`. TODO(XREQ-local-1): `credit-reservation.service.ts` (T04) chưa có hàm hoàn một
 * khoản đã `deducted` (chỉ `releaseCredit` cho khoản còn `reserved`). Vùng T13 không được sửa file đó
 * (X). Quyết định tạm: đánh dấu usage[] tương ứng `refunded` (loại khỏi trần — đúng yêu cầu DoD "không
 * tiêu trần"), NHƯNG số dư ví thật KHÔNG được hoàn cho tới khi T04 bổ sung API. Đề xuất contract-change:
 * thêm `refundDeductedCredit(reservationId | {userId, actionType, cost, projectId})` vào
 * credit-reservation.service.ts.
 */

import { Usage } from "../spine/usage.model.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { StepState } from "../spine/spine.types.js"
import { env } from "../../config/env.js"

export interface UsageEntry {
  call_kind: string
  attempt: number
  tokens_in: number
  tokens_out: number
  cost: number
  logId: string | null
}

/**
 * Ghi các lượt gọi model ĐÃ deduct thành công (ở ví) vào `usage[]`, `state: "deducted"`.
 * Trả id các document đã tạo — dùng để refund (đánh dấu `refunded`) nếu bước ghi Spine sau đó thất bại.
 */
export const recordUsage = async (
  projectId: string,
  userId: string,
  stepId: string,
  entries: readonly UsageEntry[]
): Promise<string[]> => {
  if (entries.length === 0) return []
  const expiresAt = new Date(Date.now() + env.CREDIT_RESERVE_TTL_MS)
  const docs = await Usage.insertMany(
    entries.map((entry) => ({
      projectId,
      userId,
      step_id: stepId,
      call_kind: entry.call_kind,
      attempt: entry.attempt,
      tokens_in: entry.tokens_in,
      tokens_out: entry.tokens_out,
      cost: entry.cost,
      state: "deducted",
      expires_at: expiresAt,
      logId: entry.logId
    }))
  )
  return docs.map((d) => String(d._id))
}

/**
 * Đánh dấu các dòng usage `refunded` — loại khỏi `calls_used`/`regenerate_used` (không tiêu trần).
 * Không hoàn số dư ví thật: xem TODO(XREQ-local-1) ở đầu file.
 */
export const refundUsage = async (usageIds: readonly string[]): Promise<void> => {
  if (usageIds.length === 0) return
  await Usage.updateMany({ _id: { $in: usageIds } }, { $set: { state: "refunded" } })
}

/**
 * Thời điểm bắt đầu VÒNG hiện tại của step (kể từ lần gần nhất `first_seq` được đặt lại — B7: quay lại
 * step đã accepted reset counters). `null` ⇒ đếm toàn bộ lịch sử step (vòng đầu tiên, chưa có first_seq).
 */
export const roundStartedAt = async (projectId: string, step: Pick<StepState, "first_seq"> | undefined): Promise<Date | null> => {
  if (!step || step.first_seq === null) return null
  const [change] = await spineRepository.listChanges(projectId, { fromSeq: step.first_seq, toSeq: step.first_seq })
  return change ? new Date(change.at) : null
}

export interface CountOptions {
  /** Chỉ đếm từ mốc này (vòng hiện tại của step) — bỏ qua lịch sử vòng trước khi step reopen. */
  since?: Date | null
  callKind?: string
}

/** `calls_used`/`regenerate_used`: đếm `usage[]` chưa refund của step, trong vòng hiện tại. */
export const countCalls = async (projectId: string, stepId: string, options: CountOptions = {}): Promise<number> => {
  const filter: Record<string, unknown> = { projectId, step_id: stepId, state: { $ne: "refunded" } }
  if (options.callKind) filter.call_kind = options.callKind
  if (options.since) filter.createdAt = { $gte: options.since }
  return Usage.countDocuments(filter)
}
