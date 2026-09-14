/**
 * section-status.ts
 * ─────────────────────────────────────────────────────────────────
 * `status(section)` là HÀM TÍNH (srs-spine.md §5), không lưu DB:
 *   derived   s ∈ {fixed:I, fixed:5.5}
 *   stale     ∃ change nuôi s (cột Sở hữu/Đọc/Suy dẫn) có seq > last_seq của step accepted muộn nhất nuôi s
 *   accepted  steps_of(s) ≠ ∅ và mọi step có status = accepted
 *   draft     ngược lại
 *
 * Diễn giải đã chọn (docs/spec-gaps.md):
 * - Mốc "accepted_at" so với `changes[].seq` bằng `steps[].last_seq` (cùng đơn vị seq).
 * - Change do chính step sở hữu s ghi (`step_id ∈ steps_of(s)`) không làm s stale — đó là nháp
 *   của step, status đã tính ra draft khi step chưa accepted.
 * - `awaiting_reaccept` = có step sở hữu s ở `revision_requested` (T17 hoà giải đặt, gate Accept xoá).
 */

import type { Change, Spine } from "./spine.types.js"
import { listSections, sectionsOfPath, stepsOf } from "./section-registry.js"

export type SectionStatus = "derived" | "stale" | "accepted" | "draft"

export interface SectionStateView {
  id: string
  status: SectionStatus
  awaiting_reaccept: boolean
  required: boolean
  derived: boolean
}

type ChangeLike = Pick<Change, "seq" | "path" | "before" | "value" | "step_id">

/** Seq lớn nhất của change nuôi từng section, tách theo step ghi. */
const feedingChanges = (spine: Spine, changes: ChangeLike[]): Map<string, ChangeLike[]> => {
  const bySection = new Map<string, ChangeLike[]>()
  for (const change of changes) {
    const impact = sectionsOfPath(spine, change.path, change)
    for (const id of new Set([...impact.owner, ...impact.reads, ...impact.derived])) {
      // push tại chỗ: spread mỗi lần là O(n²) theo số change của section
      const list = bySection.get(id)
      if (list) list.push(change)
      else bySection.set(id, [change])
    }
  }
  return bySection
}

/** Trạng thái mọi section của Spine, theo thứ tự FPT. */
export const computeSectionStates = (spine: Spine, changes: ChangeLike[]): SectionStateView[] => {
  const steps = new Map(spine.steps.map((s) => [s.id, s]))
  const feeding = feedingChanges(spine, changes)

  return listSections(spine).map((def) => {
    const base = { id: def.id, required: def.required, derived: def.derived }
    if (def.derived) return { ...base, status: "derived" as const, awaiting_reaccept: false }

    const own = stepsOf(def.id, spine)
    const ownSet = new Set(own)
    const states = own.map((id) => steps.get(id))
    const accepted = states.filter((s) => s?.status === "accepted")
    const awaiting = states.some((s) => s?.status === "revision_requested")

    const threshold = accepted.length > 0 ? Math.max(...accepted.map((s) => s?.last_seq ?? 0)) : null
    const stale =
      threshold !== null &&
      (feeding.get(def.id) ?? []).some((c) => c.seq > threshold && !(c.step_id !== null && ownSet.has(c.step_id)))

    const status: SectionStatus = stale
      ? "stale"
      : own.length > 0 && states.every((s) => s?.status === "accepted")
        ? "accepted"
        : "draft"
    return { ...base, status, awaiting_reaccept: awaiting }
  })
}

export const computeStatus = (spine: Spine, changes: ChangeLike[], sectionId: string): SectionStatus | null =>
  computeSectionStates(spine, changes).find((s) => s.id === sectionId)?.status ?? null

export const awaitingReaccept = (spine: Spine, sectionId: string): boolean => {
  const own = new Set(stepsOf(sectionId, spine))
  return spine.steps.some((s) => own.has(s.id) && s.status === "revision_requested")
}

export interface Readiness {
  accepted_pct: number
  awaiting_reaccept: number
  red_open: number
  stale: number
}

/** Cờ đỏ đang chặn baseline: chưa đóng và chưa waive (Phases §6.5). */
export const countRedOpen = (spine: Spine): number =>
  spine.flags.filter((f) => f.level === "red" && f.resolved_at === null && !f.waived_by_user).length

/** `% = count(accepted) / count(section bắt buộc, trừ derived)` — hiển thị, không phải điều kiện chốt. */
export const readiness = (spine: Spine, changes: ChangeLike[], states = computeSectionStates(spine, changes)): Readiness => {
  const scored = states.filter((s) => s.required && !s.derived)
  const accepted = scored.filter((s) => s.status === "accepted").length
  return {
    accepted_pct: scored.length === 0 ? 0 : Math.round((accepted * 100) / scored.length),
    awaiting_reaccept: scored.filter((s) => s.awaiting_reaccept).length,
    red_open: countRedOpen(spine),
    stale: scored.filter((s) => s.status === "stale").length
  }
}

/** Phases §6.4: 13 Brief + 38 SRS cố định. */
export const FIXED_STEP_COUNT = 51
export const STEPS_PER_SCREEN_LOOP = 5
/** N chốt ở S-4.1 (Phases §1.1). */
export const N_LOCKED_AT_STEP = "S-4.1"

export interface StepProgress {
  done: number
  total: number
  current_phase: string | null
  current_step: string | null
  show_percent: boolean
}

/** Thanh tiến độ đếm step: `51 + 5 × N`, N = số màn + 1 nếu có non-screen function. */
export const progressByStep = (spine: Spine): StepProgress => {
  const n = spine.screens.length + (spine.functions.some((f) => f.screen_id === null) ? 1 : 0)
  return {
    done: spine.steps.filter((s) => s.status === "accepted").length,
    total: FIXED_STEP_COUNT + STEPS_PER_SCREEN_LOOP * n,
    current_phase: spine.progress.current_phase,
    current_step: spine.progress.current_step,
    show_percent: spine.steps.some((s) => s.id === N_LOCKED_AT_STEP && s.status === "accepted")
  }
}

/** Body của `GET /projects/:id/progress` (pipeline.dto.ts `progressResponseSchema`). */
export const buildProgressReport = (spine: Spine, changes: ChangeLike[]) => {
  const sections = computeSectionStates(spine, changes)
  return { readiness: readiness(spine, changes, sections), progress: progressByStep(spine), sections }
}
