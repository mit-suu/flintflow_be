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
 * `meter.service` ghi LẠI các lượt vào collection `usages` (usage.model.ts, T01) để:
 *  - đếm `calls_used`/`regenerate_used` mỗi step cho trần 8/3 (đọc, không lưu số đã tính — coding-rules §3.4).
 *  - phục vụ đo token (T14/T22).
 *
 * F2/F11 (review T13): trần 8 lượt phải kiểm TRƯỚC MỖI lần gọi model, không chỉ ở cửa vào step. Để đóng
 * lỗ race giữa "đếm" và "gọi model xong mới ghi", mỗi lượt gọi model ghi TRƯỚC một dòng `state:"reserved"`
 * (`reserveCall`) — `calls_used` đếm cả `reserved` lẫn `deducted` (loại `refunded`) nên lượt đang chạy dở
 * đã tính vào trần ngay khi bắt đầu, không đợi model trả lời. Model trả lời thành công ⇒ `finalizeCall`
 * điền số liệu thật + chuyển `deducted`; lỗi/không gọi được ⇒ `releaseCall` chuyển `refunded` (không tiêu
 * trần). Kết hợp khoá in-process theo step (`step-runner.service.ts`, F2) để chặn hai request cùng chạy
 * một step.
 *
 * 409 SPINE_VERSION_CONFLICT xảy ra SAU khi model đã trả lời và credit đã deduct (draftOps chỉ trả
 * Transaction, `applyTransaction` mới chạm DB). `refundUsage` claim từng dòng `deducted → refunded` (loại
 * khỏi trần) rồi hoàn đúng `cost` về ví qua `refundDeductedCredit` (T04, XREQ-local-1 đã chốt 2026-09-15).
 */

import mongoose from "mongoose"
import { Usage } from "../spine/usage.model.js"
import { refundDeductedCredit } from "../../shared/ai/credit-reservation.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { env } from "../../config/env.js"

export interface UsageEntry {
  call_kind: string
  attempt: number
  tokens_in: number
  tokens_out: number
  cost: number
  logId: string | null
}

/** Dòng `deducted`/`refunded` là sổ vĩnh viễn (audit, đếm trần) — không cần TTL ngắn kiểu `reserved`
 *  (dọn reservation treo). Schema bắt buộc `expires_at`; đặt xa (10 năm) thay vì tái dùng TTL ngắn. */
const DEDUCTED_RETENTION_MS = 10 * 365 * 24 * 60 * 60 * 1000
const deductedExpiresAt = (): Date => new Date(Date.now() + DEDUCTED_RETENTION_MS)
const reservedExpiresAt = (): Date => new Date(Date.now() + env.CREDIT_RESERVE_TTL_MS)

/**
 * Ghi các lượt gọi model ĐÃ deduct thành công (ở ví) vào `usage[]`, `state: "deducted"` — dùng khi
 * `draftOps` (T11) trả nhiều usage entry trong một lần gọi (retry parse nội bộ, đã xảy ra thật khi hàm
 * này được gọi nên không cần bước "reserved" trung gian). Trả id các document đã tạo — dùng để refund
 * (đánh dấu `refunded`) nếu bước ghi Spine sau đó thất bại.
 */
export const recordUsage = async (
  projectId: string,
  userId: string,
  stepId: string,
  entries: readonly UsageEntry[]
): Promise<string[]> => {
  if (entries.length === 0) return []
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
      expires_at: deductedExpiresAt(),
      logId: entry.logId
    }))
  )
  return docs.map((d) => String(d._id))
}

/**
 * F2/F11: ghi TRƯỚC một dòng `state:"reserved"` (tokens/cost = 0) NGAY TRƯỚC khi gọi model — tính vào
 * `calls_used` dù model chưa trả lời, đóng lỗ hổng đua giữa lúc kiểm trần và lúc model trả lời. Gọi
 * `finalizeCall` khi model trả lời thành công, `releaseCall` khi lỗi/không gọi được.
 */
export const reserveCall = async (projectId: string, userId: string, stepId: string, callKind: string): Promise<string> => {
  const [doc] = await Usage.insertMany([
    {
      projectId,
      userId,
      step_id: stepId,
      call_kind: callKind,
      attempt: 1,
      tokens_in: 0,
      tokens_out: 0,
      cost: 0,
      state: "reserved",
      expires_at: reservedExpiresAt(),
      logId: null
    }
  ])
  return String(doc._id)
}

/** Điền số liệu thật + chuyển `reserved` → `deducted` sau khi model trả lời thành công. */
export const finalizeCall = async (usageId: string, entry: UsageEntry): Promise<void> => {
  await Usage.updateMany(
    { _id: usageId },
    {
      $set: {
        call_kind: entry.call_kind,
        attempt: entry.attempt,
        tokens_in: entry.tokens_in,
        tokens_out: entry.tokens_out,
        cost: entry.cost,
        logId: entry.logId,
        state: "deducted",
        expires_at: deductedExpiresAt()
      }
    }
  )
}

/** Model lỗi / không gọi được: chuyển `reserved` → `refunded` (không tiêu trần). */
export const releaseCall = async (usageId: string): Promise<void> => {
  await Usage.updateMany({ _id: usageId }, { $set: { state: "refunded" } })
}

/**
 * Đánh dấu các dòng usage `refunded` — loại khỏi `calls_used`/`regenerate_used` (không tiêu trần) — và hoàn
 * `cost` của dòng đang `deducted` về ví. Claim từng dòng trước khi hoàn nên gọi lại không hoàn hai lần.
 */
export const refundUsage = async (usageIds: readonly string[]): Promise<void> => {
  for (const usageId of usageIds) {
    const claimed = await Usage.findOneAndUpdate({ _id: usageId, state: "deducted" }, { $set: { state: "refunded" } })
    if (claimed) {
      await refundDeductedCredit({
        userId: String(claimed.userId),
        actionType: claimed.call_kind,
        amount: claimed.cost,
        projectId: String(claimed.projectId)
      })
      continue
    }
    await Usage.updateMany({ _id: usageId, state: { $ne: "refunded" } }, { $set: { state: "refunded" } })
  }
}

/**
 * F1: mốc bắt đầu VÒNG hiện tại của step = `at` của change GẦN NHẤT đặt `steps[id=stepId].status =
 * "in_progress"` **TRƯỚC `firstSeq` hiện tại của step** (runner ghi transition này qua `applyTransaction`
 * TRƯỚC mọi lượt gọi model trong `runStep` — xem `step-runner.service.ts`). Dùng transition thật thay vì
 * đọc đúng change TẠI `firstSeq` (cách cũ) vì usage của Elicit được ghi TRƯỚC change nội dung đầu tiên
 * (first_seq trỏ change nội dung, không phải lúc step bắt đầu) — cách cũ loại nhầm usage Elicit khỏi
 * `calls_used`.
 *
 * Chặn tại `firstSeq` (không tìm KHÔNG giới hạn) vì `gate.service` cũng ghi `steps[id=X].status =
 * "in_progress"` khi MỘT revision (không phải B7 reopen) hoàn tất — nếu tìm mốc "in_progress" gần nhất
 * không giới hạn, transition này (xảy ra SAU khi đã gọi model, seq lớn hơn firstSeq) sẽ bị nhận nhầm làm
 * mốc vòng mới, loại luôn usage của chính lượt revision đó. `firstSeq` là mốc tin cậy vì luôn được cập
 * nhật đúng theo dải seq THẬT của vòng hiện tại (`trackSeqRange`, F3) và chỉ reset về null ở B7 reopen —
 * đúng ngữ nghĩa "regenerate/revision trong cùng vòng không đổi mốc; chỉ B7 reopen tạo vòng mới".
 * `firstSeq = null` (step chưa có nội dung nào trong vòng — vòng đầu hoặc vừa reopen) ⇒ tìm không giới
 * hạn (không có transition "incidental" nào có thể xảy ra trước khi có nội dung).
 */
/**
 * Change nào đánh dấu "bắt đầu vòng"? Bình thường là `steps[id=X].status = "in_progress"` (runStep kích
 * hoạt step). Riêng B7 reopen qua `gate.service` (revision/regenerate trên step đã accepted) chuyển thẳng
 * `accepted → revision_requested` (KHÔNG qua "in_progress" trước khi có nội dung mới — action regenerate
 * không bao giờ tự đặt lại "in_progress" trong cùng lượt) — transition đó CŨNG là mốc vòng mới.
 */
const isRoundStartChange = (path: string, change: { path: string; value: unknown; before: unknown }): boolean => {
  if (change.path !== path) return false
  if (change.value === "in_progress") return true
  return change.value === "revision_requested" && change.before === "accepted"
}

export const roundStartedAt = async (projectId: string, stepId: string, firstSeq: number | null): Promise<Date | null> => {
  const changes = await spineRepository.listChanges(projectId, firstSeq !== null ? { toSeq: firstSeq - 1 } : {})
  const path = `steps[id=${stepId}].status`
  let latest: Date | null = null
  for (const c of changes) {
    // Lọc lại seq < firstSeq trong bộ nhớ (không chỉ dựa vào `toSeq` ở query) — phòng khi range không được
    // tôn trọng đúng (vd double-check an toàn, khớp cách roundCountsForSteps lọc trong bộ nhớ).
    if (firstSeq !== null && c.seq >= firstSeq) continue
    if (isRoundStartChange(path, c)) latest = new Date(c.at)
  }
  return latest
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

export interface RoundCounts {
  calls_used: number
  regenerate_used: number
}

/**
 * `calls_used` + `regenerate_used` của vòng hiện tại — dùng chung bởi step-runner/gate/controller (DRY).
 * `firstSeq`: `first_seq` HIỆN TẠI của step (trước khi lệnh đang xử lý có thể làm thay đổi nó) — neo mốc
 * vòng, xem `roundStartedAt`. `null` nếu step chưa có nội dung trong vòng hiện tại (vòng đầu / vừa reopen).
 */
export const roundCounts = async (projectId: string, stepId: string, firstSeq: number | null): Promise<RoundCounts> => {
  const since = await roundStartedAt(projectId, stepId, firstSeq)
  const [calls_used, regenerate_used] = await Promise.all([
    countCalls(projectId, stepId, { since }),
    countCalls(projectId, stepId, { since, callKind: "regenerate" })
  ])
  return { calls_used, regenerate_used }
}

/**
 * Credit đã tiêu cho vòng hiện tại của step — gate hiện "58 giây · 4 credit" (03 Lớp 4) để user thấy giá
 * của mỗi bước, thay vì chỉ thấy số dư tụt dần không rõ vì sao.
 */
export const roundCost = async (projectId: string, stepId: string, firstSeq: number | null): Promise<number> => {
  const since = await roundStartedAt(projectId, stepId, firstSeq)
  const filter: Record<string, unknown> = { projectId, step_id: stepId, state: { $ne: "refunded" } }
  if (since) filter.createdAt = { $gte: since }
  const rows = (await Usage.find(filter, { cost: 1 }).lean()) as unknown as { cost?: number }[]
  return rows.reduce((sum, r) => sum + (typeof r.cost === "number" ? r.cost : 0), 0)
}

interface UsageRow {
  step_id: string
  call_kind: string
  createdAt: string | Date
}

export interface StepRoundInput {
  id: string
  first_seq: number | null
}

/**
 * F10: `GET /steps` cần `calls_used`/`regenerate_used` của 51 + 5×N step — gọi `roundCounts` cho từng
 * step tạo ra ~2-3×N truy vấn (N+1). Gộp còn 2 truy vấn: một `listChanges` KHÔNG giới hạn (đủ để suy mốc
 * vòng mọi step theo `first_seq` riêng — xem `roundStartedAt`) và một `Usage.aggregate` lấy thô mọi dòng
 * chưa refund của các step liên quan, rồi đếm trong bộ nhớ theo mốc vòng riêng từng step (mốc lệch nhau
 * giữa các step nên không gộp được thành một `$match` theo thời gian chung — đây là lý do dùng `aggregate`
 * để lấy thô thay vì `$group` ngay trong Mongo).
 */
export const roundCountsForSteps = async (projectId: string, steps: readonly StepRoundInput[]): Promise<Map<string, RoundCounts>> => {
  const result = new Map<string, RoundCounts>()
  for (const step of steps) result.set(step.id, { calls_used: 0, regenerate_used: 0 })
  if (steps.length === 0) return result

  const [changes, usageRows] = await Promise.all([
    spineRepository.listChanges(projectId),
    Usage.aggregate([
      { $match: { projectId: new mongoose.Types.ObjectId(projectId), step_id: { $in: steps.map((s) => s.id) }, state: { $ne: "refunded" } } },
      { $project: { _id: 0, step_id: 1, call_kind: 1, createdAt: 1 } }
    ]) as unknown as Promise<UsageRow[]>
  ])

  const firstSeqByStep = new Map(steps.map((s) => [s.id, s.first_seq]))
  const sinceByStep = new Map<string, Date | null>()
  for (const step of steps) sinceByStep.set(step.id, null)
  for (const c of changes) {
    const match = /^steps\[id=(.+)\]\.status$/.exec(c.path)
    if (!match || !sinceByStep.has(match[1])) continue
    if (!isRoundStartChange(c.path, c)) continue
    const firstSeq = firstSeqByStep.get(match[1]) ?? null
    if (firstSeq !== null && c.seq >= firstSeq) continue // F1: transition SAU firstSeq là toggle nội bộ của gate, không phải mốc vòng
    const current = sinceByStep.get(match[1]) ?? null
    if (!current || new Date(c.at) > current) sinceByStep.set(match[1], new Date(c.at))
  }

  for (const row of usageRows) {
    const entry = result.get(row.step_id)
    if (!entry) continue
    const since = sinceByStep.get(row.step_id)
    if (since && new Date(row.createdAt) < since) continue
    entry.calls_used += 1
    if (row.call_kind === "regenerate") entry.regenerate_used += 1
  }

  return result
}
