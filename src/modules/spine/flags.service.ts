/**
 * flags.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Đồng bộ `flags[]` với kết quả deterministic check (srs-spine.md §7), waiver có hạn.
 * Mọi ghi đi qua op engine (`applyTransaction`) — không ghi thẳng DB (coding-rules §3.3).
 *
 * Khoá flag `(level, rule_id, section_id, target_id, resolved_at IS NULL)`:
 * - ứng viên chưa có cờ mở ⇒ thêm dòng mới (cờ tái phát sau khi đóng cũng là dòng mới)
 * - cờ mở không còn ứng viên ⇒ đặt `resolved_at`
 * - cờ đã waive mà `spine_version` ≠ `waived_at_version` và điều kiện vẫn đúng ⇒ waiver mất, cờ mở lại
 *
 * Transaction chỉ đổi flags (recompute, waive) cũng tăng `spine_version`. Để waiver không tự hết hạn
 * vì chính các lần ghi flag, lô đó đẩy `waived_at_version` của waiver còn hiệu lực lên version mới.
 */

import type { Flag, Spine, SpineRecord } from "./spine.types.js"
import type { ApplyResult, Op } from "./op.types.js"
import * as repository from "./spine.repository.js"
import { applyTransaction } from "./op-engine.js"
import { NON_WAIVABLE_RULES, flagKey, runDeterministicCheck, type FlagCandidate } from "./deterministic-check.js"
import { WAIVE_REASON_MIN_LENGTH } from "./spine.schema.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const FLAG_NOT_FOUND = "FLAG_NOT_FOUND"
export const FLAG_NOT_WAIVABLE = "FLAG_NOT_WAIVABLE"

export interface FlagPlan {
  ops: Op[]
  opened: string[]
  resolved: string[]
  reopened: string[]
}

const FLAG_ID_RE = /^FL(\d+)$/

const flagIdGenerator = (flags: Flag[]): (() => string) => {
  let n = Math.max(0, ...flags.map((f) => Number(FLAG_ID_RE.exec(f.id)?.[1] ?? 0)))
  return () => `FL${String(++n).padStart(3, "0")}`
}

const flagPath = (id: string, field: string) => `flags[id=${id}].${field}`

/** Waiver còn hiệu lực ở version hiện tại ⇒ đẩy theo version lô chỉ-flag sắp ghi. */
const refreshWaiverOps = (spine: Spine, skip: ReadonlySet<string>): Op[] =>
  spine.flags
    .filter((f) => f.resolved_at === null && f.waived_by_user && f.waived_at_version === spine.spine_version && !skip.has(f.id))
    .map((f) => ({
      op: "set" as const,
      path: flagPath(f.id, "waived_at_version"),
      value: spine.spine_version + 1,
      reason: "Waiver giữ hiệu lực: lô chỉ cập nhật cờ"
    }))

/** Kế hoạch thuần: ops đưa `flags[]` về khớp `candidates`. */
export const planFlagOps = (spine: Spine, candidates: FlagCandidate[], now: Date = new Date()): FlagPlan => {
  const at = now.toISOString()
  const open = new Map(spine.flags.filter((f) => f.resolved_at === null).map((f) => [flagKey(f), f]))
  const nextId = flagIdGenerator(spine.flags)
  const plan: FlagPlan = { ops: [], opened: [], resolved: [], reopened: [] }
  const touched = new Set<string>()
  const seen = new Set<string>()

  for (const c of candidates) {
    const key = flagKey(c)
    if (seen.has(key)) continue
    seen.add(key)

    const existing = open.get(key)
    if (!existing) {
      const id = nextId()
      const value: Flag = {
        id,
        level: c.level,
        rule_id: c.rule_id,
        section_id: c.section_id,
        target_id: c.target_id,
        message: c.message,
        remediation_step: c.remediation_step,
        opened_at_version: spine.spine_version + 1,
        resolved_at: null,
        waived_by_user: false,
        waive_reason: null,
        waived_at_version: null
      }
      plan.ops.push({ op: "add", path: "flags[]", value, reason: `Mở cờ ${c.rule_id}` })
      plan.opened.push(id)
      continue
    }

    if (existing.message !== c.message) plan.ops.push({ op: "set", path: flagPath(existing.id, "message"), value: c.message })
    if (existing.remediation_step !== c.remediation_step) {
      plan.ops.push({ op: "set", path: flagPath(existing.id, "remediation_step"), value: c.remediation_step })
    }
    if (existing.waived_by_user && existing.waived_at_version !== spine.spine_version) {
      const reason = "Waiver hết hạn: nội dung đã đổi mà điều kiện lỗi vẫn đúng"
      plan.ops.push(
        { op: "set", path: flagPath(existing.id, "waived_by_user"), value: false, reason },
        { op: "set", path: flagPath(existing.id, "waive_reason"), value: null, reason },
        { op: "set", path: flagPath(existing.id, "waived_at_version"), value: null, reason }
      )
      plan.reopened.push(existing.id)
      touched.add(existing.id)
    }
  }

  for (const [key, flag] of open) {
    if (seen.has(key)) continue
    plan.ops.push({ op: "set", path: flagPath(flag.id, "resolved_at"), value: at, reason: `Đóng cờ ${flag.rule_id}: điều kiện không còn` })
    plan.resolved.push(flag.id)
    touched.add(flag.id)
  }

  if (plan.ops.length > 0) plan.ops.push(...refreshWaiverOps(spine, touched))
  return plan
}

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

const load = async (projectId: string): Promise<SpineRecord> => {
  const spine = await repository.get(projectId)
  if (!spine) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  return spine
}

export interface RecomputeResult {
  checked_at_version: number
  flags: Flag[]
  opened: string[]
  resolved: string[]
  reopened: string[]
}

export interface RecomputeOptions {
  atBaseline?: boolean
  by: string
}

/** Chạy lại deterministic check trên `spine_version` hiện tại và ghi `flags[]` (không ghi nếu không đổi). */
export const recompute = async (projectId: string, options: RecomputeOptions): Promise<RecomputeResult> => {
  const record = await load(projectId)
  const changes = await repository.listChanges(projectId)
  const spine = stripRecord(record)
  const candidates = runDeterministicCheck(spine, changes, { atBaseline: options.atBaseline ?? false })
  const plan = planFlagOps(spine, candidates)

  if (plan.ops.length === 0) {
    return { checked_at_version: record.spine_version, flags: record.flags, opened: [], resolved: [], reopened: [] }
  }

  const result: ApplyResult = await applyTransaction(projectId, {
    base_version: record.spine_version,
    ops: plan.ops,
    by: options.by,
    reason: "Recompute deterministic flags",
    step_id: null
  })
  return {
    checked_at_version: result.spine_version,
    flags: result.spine.flags,
    opened: plan.opened,
    resolved: plan.resolved,
    reopened: plan.reopened
  }
}

/** Waive một cờ: lý do user gõ ≥ 20 ký tự; cấm `array_empty`/`dead_reference`/`render_error`. */
export const waive = async (projectId: string, flagId: string, reason: string, userId: string): Promise<Flag> => {
  const record = await load(projectId)
  const flag = record.flags.find((f) => f.id === flagId)
  if (!flag) throw new ApiError(404, `Không tìm thấy cờ ${flagId}`, FLAG_NOT_FOUND)
  if (NON_WAIVABLE_RULES.has(flag.rule_id)) {
    throw new ApiError(400, `Cờ ${flag.rule_id} không được waive — phải sửa dữ liệu`, FLAG_NOT_WAIVABLE)
  }
  if (flag.resolved_at !== null) throw new ApiError(400, `Cờ ${flagId} đã đóng`, FLAG_NOT_WAIVABLE)

  const text = reason.trim()
  if (text.length < WAIVE_REASON_MIN_LENGTH) {
    throw new ApiError(400, `Lý do waive cần ít nhất ${WAIVE_REASON_MIN_LENGTH} ký tự`, "VALIDATION_ERROR")
  }

  const spine = stripRecord(record)
  const nextVersion = record.spine_version + 1
  const result = await applyTransaction(projectId, {
    base_version: record.spine_version,
    ops: [
      { op: "set", path: flagPath(flagId, "waived_by_user"), value: true },
      { op: "set", path: flagPath(flagId, "waive_reason"), value: text },
      { op: "set", path: flagPath(flagId, "waived_at_version"), value: nextVersion },
      ...refreshWaiverOps(spine, new Set([flagId]))
    ],
    by: userId,
    reason: `Waive ${flag.rule_id}`,
    step_id: null
  })

  const updated = result.spine.flags.find((f) => f.id === flagId)
  if (!updated) throw new ApiError(404, `Không tìm thấy cờ ${flagId}`, FLAG_NOT_FOUND)
  return updated
}

export interface FlagFilter {
  level?: "red" | "yellow"
  /** true: chưa đóng (kể cả đã waive); false: đã đóng. */
  open?: boolean
}

export const filterFlags = (flags: Flag[], filter: FlagFilter = {}): Flag[] =>
  flags.filter(
    (f) =>
      (filter.level === undefined || f.level === filter.level) &&
      (filter.open === undefined || (f.resolved_at === null) === filter.open)
  )
