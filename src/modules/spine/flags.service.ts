/**
 * flags.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Đồng bộ `flags[]` với kết quả deterministic check (srs-spine.md §7), waiver có hạn.
 * Mọi ghi đi qua op engine (`applyTransaction`) — không ghi thẳng DB (coding-rules §3.3).
 *
 * Khoá flag `(level, rule_id, section_id, target_id, resolved_at IS NULL)`:
 * - ứng viên chưa có cờ mở ⇒ thêm dòng mới (cờ tái phát sau khi đóng cũng là dòng mới)
 * - cờ mở không còn ứng viên ⇒ đặt `resolved_at`
 * - cờ đã waive mà **đối tượng của cờ** đổi sau lúc waive và điều kiện vẫn đúng ⇒ waiver mất, cờ mở lại
 *
 * FLF-243: trước đây mọi lần ghi (kể cả step runner ghi `progress`, sửa một function không liên quan) đều
 * làm waiver hết hạn — user bỏ qua cờ "Vai trò Guest chưa gắn tác nhân", chạy tiếp S-5 là cờ hiện lại.
 * Nay chỉ change chạm đúng phần tử `target_id` (hoặc, với cờ cấp mục, field mà mục đó sở hữu) mới tính.
 *
 * Transaction chỉ đổi flags (recompute, waive) cũng tăng `spine_version`. Để waiver không tự hết hạn
 * vì chính các lần ghi flag, lô đó đẩy `waived_at_version` của waiver còn hiệu lực lên version mới.
 */

import type { Change, Flag, Spine, SpineRecord } from "./spine.types.js"
import type { ApplyResult, Op } from "./op.types.js"
import * as repository from "./spine.repository.js"
import { applyTransaction } from "./op-engine.js"
import { MODEL_OWNED_RULES, NON_WAIVABLE_RULES, RULES, flagKey, runDeterministicCheck, type FlagCandidate, type RuleProfile } from "./deterministic-check.js"
import { WAIVE_REASON_MIN_LENGTH } from "./spine.schema.js"
import { sectionsOfPath } from "./section-registry.js"
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

/** Luật chỉ chạy ở S-9 (`atBaseline`). */
const AT_BASELINE_RULES: ReadonlySet<string> = new Set(RULES.filter((r) => r.at_baseline).map((r) => r.rule_id))

export interface FlagPlanOptions {
  /** Lần check có chạy luật S-9 không. Không chạy thì cờ S-9 đang mở không được coi là đã hết lỗi. */
  atBaseline?: boolean
  /**
   * Ứng viên S-9 tính trên Spine hiện tại (`atBaseline: true`). Có danh sách này thì lần check thường:
   * - đóng cờ S-9 đang mở mà điều kiện đã hết (mục đã cũ nay đã chốt lại — bước đã accepted, `/run` từ chối, user
   *   không còn cách nào xử lý ngoài Waive một cờ đỏ);
   * - với mục từng mang cờ "mục đã cũ" / "chờ duyệt lại", theo dõi tiếp hai luật đó cả khi mở cờ: mục hết cũ nhưng
   *   bước sở hữu đang `revision_requested` phải chuyển sang cờ đỏ "chờ duyệt lại", không được im lặng mất cờ.
   * Các luật S-9 khác vẫn không mở cờ mới ngoài S-9.
   */
  baselineCandidates?: readonly FlagCandidate[]
  /**
   * `changes[]` của project: có thì waiver chỉ hết hạn khi change sau lúc waive chạm đối tượng của cờ
   * (`waiverLapsed`). Không có ⇒ quy tắc cũ, mọi đổi `spine_version` đều làm waiver hết hạn.
   */
  changes?: readonly Change[]
}

/** Luật S-9 cấp mục: đã từng gắn cho một mục thì theo dõi liên tục (xem `baselineCandidates`). */
const TRACKED_SECTION_RULES: ReadonlySet<string> = new Set(["section_stale_at_baseline", "section_awaiting_reaccept"])

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

/** seq của lần waive gần nhất: dòng `flags[id=…].waived_by_user = true` trong `changes[]`. */
const waivedAtSeq = (changes: readonly Change[], flagId: string): number | null => {
  const path = flagPath(flagId, "waived_by_user")
  let seq: number | null = null
  for (const c of changes) if (c.path === path && c.value === true && (seq === null || c.seq > seq)) seq = c.seq
  return seq
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Change chạm đối tượng của cờ: path chọn đúng phần tử `target_id` (`roles[id=R04].actor_id`,
 * `permissions[screen_id=S3,role_id=R04,action=create]`); cờ không có `target_id` thì xét field mà mục
 * của cờ sở hữu. Ghi `flags[]` không bao giờ tính — đó chính là lần waive.
 */
const touchesFlag = (spine: Spine, flag: Flag, change: Change): boolean => {
  if (change.path === "$") return true
  if (change.path.startsWith("flags[")) return false
  if (flag.target_id) return new RegExp(`[\\[,][A-Za-z_]+=${escapeRegExp(flag.target_id)}[,\\]]`).test(change.path)
  return sectionsOfPath(spine, change.path, change).owner.includes(flag.section_id)
}

/** Waiver hết hạn? Có `changes[]` thì chỉ khi đối tượng của cờ đổi sau lúc waive; không thì theo version. */
const waiverLapsed = (spine: Spine, flag: Flag, changes: readonly Change[] | undefined): boolean => {
  if (flag.waived_at_version === spine.spine_version) return false
  const since = changes ? waivedAtSeq(changes, flag.id) : null
  if (changes === undefined || since === null) return true
  return changes.some((c) => c.seq > since && touchesFlag(spine, flag, c))
}

/** Kế hoạch thuần: ops đưa `flags[]` về khớp `candidates`. */
export const planFlagOps = (
  spine: Spine,
  candidates: FlagCandidate[],
  now: Date = new Date(),
  options: FlagPlanOptions = {}
): FlagPlan => {
  const at = now.toISOString()
  const open = new Map(spine.flags.filter((f) => f.resolved_at === null).map((f) => [flagKey(f), f]))
  const nextId = flagIdGenerator(spine.flags)
  const plan: FlagPlan = { ops: [], opened: [], resolved: [], reopened: [] }
  const touched = new Set<string>()
  const seen = new Set<string>()

  const baseline = options.atBaseline ? undefined : options.baselineCandidates
  const baselineKeys = baseline ? new Set(baseline.map(flagKey)) : undefined
  const trackedSections = new Set(spine.flags.filter((f) => TRACKED_SECTION_RULES.has(f.rule_id)).map((f) => f.section_id))
  const tracked = (baseline ?? []).filter((c) => TRACKED_SECTION_RULES.has(c.rule_id) && trackedSections.has(c.section_id))

  for (const c of [...candidates, ...tracked]) {
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
    if (existing.waived_by_user && waiverLapsed(spine, existing, options.changes)) {
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
    // Check thường không chạy luật S-9 nên không có ứng viên của chúng — không có nghĩa lỗi đã hết. Chỉ đóng khi
    // điều kiện S-9 đã tính lại (`baselineCandidates`) mà không còn đúng.
    if (!options.atBaseline && AT_BASELINE_RULES.has(flag.rule_id) && (!baselineKeys || baselineKeys.has(key))) continue
    // Cờ do gate/model đặt (accepted_as_is, goal_not_covered) không bao giờ là ứng viên của check tất định
    if (MODEL_OWNED_RULES.has(flag.rule_id)) continue
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
  if (!spine) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", repository.SPINE_NOT_FOUND)
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
  /** Mode 1 (FLF-171): luật loại trừ / hạ mức — xem `deterministic-check.ts#RuleProfile`. */
  ruleProfile?: RuleProfile
}

/**
 * Hồ sơ luật mặc định theo project khi caller không truyền `ruleProfile` (FLF-183): module import đăng ký resolver
 * trả hồ sơ mode 1 cho project `mode = import` — step runner, `/changes`, sign-off… dùng đúng luật mà không phải biết mode.
 * Không đăng ký (unit test, mode 2) ⇒ `undefined` = đủ luật.
 */
export type RuleProfileResolver = (projectId: string) => Promise<RuleProfile | undefined>
let ruleProfileResolver: RuleProfileResolver = async () => undefined
export const setRuleProfileResolver = (resolver: RuleProfileResolver): void => {
  ruleProfileResolver = resolver
}

/** Chạy lại deterministic check trên `spine_version` hiện tại và ghi `flags[]` (không ghi nếu không đổi). */
export const recompute = async (projectId: string, options: RecomputeOptions): Promise<RecomputeResult> => {
  const record = await load(projectId)
  const changes = await repository.listChanges(projectId)
  const spine = stripRecord(record)
  const atBaseline = options.atBaseline ?? false
  const ruleProfile = options.ruleProfile ?? (await ruleProfileResolver(projectId))
  const candidates = runDeterministicCheck(spine, changes, { atBaseline, ruleProfile })
  const baselineCandidates = atBaseline
    ? undefined
    : runDeterministicCheck(spine, changes, { atBaseline: true, ruleProfile }).filter((c) => AT_BASELINE_RULES.has(c.rule_id))
  const plan = planFlagOps(spine, candidates, new Date(), { atBaseline, baselineCandidates, changes })

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
  if (!flag) throw new ApiError(404, "Không tìm thấy cờ này.", FLAG_NOT_FOUND)
  if (NON_WAIVABLE_RULES.has(flag.rule_id)) {
    throw new ApiError(400, "Cờ này không bỏ qua được — cần sửa dữ liệu.", FLAG_NOT_WAIVABLE, { rule_id: flag.rule_id })
  }
  if (flag.resolved_at !== null) throw new ApiError(400, "Cờ này đã đóng.", FLAG_NOT_WAIVABLE)

  const text = reason.trim()
  if (text.length < WAIVE_REASON_MIN_LENGTH) {
    throw new ApiError(400, `Lý do bỏ qua cờ cần ít nhất ${WAIVE_REASON_MIN_LENGTH} ký tự.`, "VALIDATION_ERROR")
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
  if (!updated) throw new ApiError(404, "Không tìm thấy cờ này.", FLAG_NOT_FOUND)
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
