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
import { isRegisteredStep, loadStepRegistry, parseStepId } from "../pipeline/step-registry.js"

export type SectionStatus = "derived" | "stale" | "accepted" | "draft"

export interface SectionStateView {
  id: string
  status: SectionStatus
  awaiting_reaccept: boolean
  required: boolean
  derived: boolean
}

type ChangeLike = Pick<Change, "seq" | "path" | "before" | "value" | "step_id"> & { reason?: string | null }

/** `Revert seq 42` — reason mà op-engine ghi cho change nghịch đảo (undo). */
const REVERT_OF = /^Revert seq (\d+)$/

/** Cặp hoàn tác: seq của change nghịch đảo → seq change gốc nó đảo (chỉ khi change gốc còn trong danh sách). */
export const revertPairs = (changes: readonly ChangeLike[]): Map<number, number> => {
  const present = new Set(changes.map((c) => c.seq))
  const out = new Map<number, number>()
  for (const change of changes) {
    const source = REVERT_OF.exec(change.reason ?? "")?.[1]
    if (source !== undefined && present.has(Number(source))) out.set(change.seq, Number(source))
  }
  return out
}

/**
 * FLF-431 (FAP #22): change sau mốc duyệt mà đã triệt tiêu với lượt hoàn tác của nó — cặp (gốc sau mốc, nghịch đảo) không
 * làm section cũ: nội dung đã về đúng bản đã duyệt. Change gốc TRƯỚC mốc mà bị hoàn tác sau mốc thì nội dung đã khác bản duyệt
 * ⇒ vẫn cũ. Hàm tính, không lưu gì.
 */
export const isCancelledAfter = (seq: number, threshold: number, pairs: ReadonlyMap<number, number>, revertedBy: ReadonlySet<number>): boolean => {
  const source = pairs.get(seq)
  if (source !== undefined) return source > threshold
  return revertedBy.has(seq)
}

const sourceHashOf = (value: unknown): unknown =>
  value !== null && typeof value === "object" ? (value as { source_hash?: unknown }).source_hash : undefined

/**
 * Vẽ lại một sơ đồ mà dữ liệu nguồn không đổi (`source_hash` trước = sau): chỉ compile lại hình ("Vẽ lại tất
 * cả", thử lại sau lỗi PlantUML). Nội dung người đọc duyệt không đổi nên không làm section stale — trước đây
 * một lần "Vẽ lại tất cả" đẩy mọi section có sơ đồ về "Cũ" và tụt % đã chốt. Nguồn đổi thì change của chính
 * trường nguồn (và hash mới) vẫn làm stale như thường.
 */
export const isRerenderOnly = (change: Pick<ChangeLike, "path" | "before" | "value">): boolean => {
  if (!/^diagrams\[id=[^\]]+\]$/.test(change.path)) return false
  const before = sourceHashOf(change.before)
  if (typeof before !== "string") return false
  if (before === sourceHashOf(change.value)) return true
  // FLF-431: vẽ lại theo dữ liệu nguồn mới (hash đổi) — hình là hàm thuần của dữ liệu, và chính change của trường nguồn
  // đã làm section stale (hoặc đã được duyệt lại). Tính thêm change của hình thì mỗi lần "Vẽ lại tất cả" / vẽ lại tự động
  // ở S-9 lại đẻ cờ "Viết lại cho khớp" mới, sửa cờ này sinh cờ kia (E2E BarberGo, luồng C #12). Trừ bố cục màn: ScreenSpec
  // do AI soạn, không suy ra được từ dữ liệu ⇒ vẫn là nội dung người dùng duyệt.
  return kindOf(change.before) !== "screen_layout" && kindOf(change.value) !== "screen_layout"
}

const kindOf = (value: unknown): unknown => (value !== null && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined)

/** Seq lớn nhất của change nuôi từng section, tách theo step ghi. */
const feedingChanges = (spine: Spine, changes: ChangeLike[]): Map<string, ChangeLike[]> => {
  const bySection = new Map<string, ChangeLike[]>()
  for (const change of changes) {
    if (isRerenderOnly(change)) continue
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

/**
 * FLF-204 (BUG-26): section của một feature chỉ `accepted` khi MỌI function con của nó cũng đã `accepted`.
 * Lượt test cho ra §3.7 vừa ghi feature "Accepted" vừa ghi function bên dưới "Draft · Chưa hoàn thiện" —
 * hai nhãn mâu thuẫn ngay cạnh nhau, và nhãn ở trên là nhãn người đọc tin.
 */
const downgradePartialFeatures = (spine: Spine, states: SectionStateView[]): SectionStateView[] => {
  const byId = new Map(states.map((s) => [s.id, s]))
  return states.map((state) => {
    if (state.status !== "accepted" || !state.id.startsWith("feature:")) return state
    const featureId = state.id.slice("feature:".length)
    // Function của màn đã được user chủ động để lại (`placeholder`) không tính — việc đó có cờ riêng
    // (`screen_placeholder`), không phải chuyện feature chưa xong.
    const deferred = new Set(spine.screens.filter((sc) => sc.detail_status === "placeholder").map((sc) => sc.id))
    const children = spine.functions.filter((f) => f.feature_id === featureId && (f.screen_id === null || !deferred.has(f.screen_id)))
    const unfinished = children.some((f) => (byId.get(`function:${f.id}`)?.status ?? "draft") === "draft")
    return unfinished ? { ...state, status: "draft" as const } : state
  })
}

/**
 * Seq của lượt ghi `accepted_at` gần nhất cho mỗi step — mốc "đã xem tới đây".
 *
 * `last_seq` chỉ có khi step THỰC SỰ ghi nội dung. Bước tất định chạy lại mà không đổi gì (sơ đồ vẽ lại
 * y hệt) chốt với `last_seq = null`, và khi đó ngưỡng 0 làm mọi change nuôi section thành "mới hơn" —
 * section cũ vĩnh viễn, chạy lại bao nhiêu lần cũng không sạch cờ.
 */
export const acceptSeqByStep = (changes: readonly ChangeLike[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const change of changes) {
    const match = /^steps\[id=([^\]]+)\]\.accepted_at$/.exec(change.path)
    if (!match || change.value === null) continue
    out.set(match[1], Math.max(out.get(match[1]) ?? 0, change.seq))
  }
  return out
}

/** Trạng thái mọi section của Spine, theo thứ tự FPT. */
export const computeSectionStates = (spine: Spine, changes: ChangeLike[]): SectionStateView[] => {
  const steps = new Map(spine.steps.map((s) => [s.id, s]))
  const feeding = feedingChanges(spine, changes)
  const acceptedAtSeq = acceptSeqByStep(changes)
  const pairs = revertPairs(changes)
  const revertedBy = new Set(pairs.values())

  const states = listSections(spine).map((def) => {
    const base = { id: def.id, required: def.required, derived: def.derived }
    if (def.derived) return { ...base, status: "derived" as const, awaiting_reaccept: false }

    const own = stepsOf(def.id, spine)
    const ownSet = new Set(own)
    const states = own.map((id) => steps.get(id))
    const accepted = states.filter((s) => s?.status === "accepted")
    const awaiting = states.some((s) => s?.status === "revision_requested")

    const threshold =
      accepted.length > 0 ? Math.max(...accepted.map((s) => Math.max(s?.last_seq ?? 0, acceptedAtSeq.get(s?.id ?? "") ?? 0))) : null
    const stale =
      threshold !== null &&
      (feeding.get(def.id) ?? []).some(
        (c) => c.seq > threshold && !(c.step_id !== null && ownSet.has(c.step_id)) && !isCancelledAfter(c.seq, threshold, pairs, revertedBy)
      )

    const status: SectionStatus = stale
      ? "stale"
      : own.length > 0 && states.every((s) => s?.status === "accepted")
        ? "accepted"
        : "draft"
    return { ...base, status, awaiting_reaccept: awaiting }
  })

  return downgradePartialFeatures(spine, states)
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

/** Cờ đỏ đang chặn baseline: mọi cờ đỏ chưa đóng — waive / giữ nguyên không làm nó hết chặn (BR-04, FLF-329). */
export const countRedOpen = (spine: Spine): number =>
  spine.flags.filter((f) => f.level === "red" && f.resolved_at === null).length

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

/** Phases §6.4: 12 Brief + 38 SRS cố định. */
export const FIXED_STEP_COUNT = 50
/** Số step vòng màn của mẫu ĐẦY ĐỦ (FlintFlow chuẩn). Cấu trúc đích thiếu mục thì dùng `stepsPerScreen(profile)`. */
export const STEPS_PER_SCREEN_LOOP = 5
/** N chốt ở S-4.1 (Phases §1.1). */
export const N_LOCKED_AT_STEP = "S-4.1"

/**
 * Cấu trúc đích của vòng màn (FLF-466 P08): template step vòng S-5 KHÔNG áp dụng cho mẫu của dự án (vd mẫu không có
 * Screen Layout ⇒ bỏ S-5.3). Rỗng ⇒ mẫu chuẩn, đủ step.
 */
export interface ScreenLoopProfile {
  skippedTemplates: ReadonlySet<string>
}

export const FULL_SCREEN_LOOP: ScreenLoopProfile = { skippedTemplates: new Set() }

const loopTemplateIds = (): string[] => loadStepRegistry().filter((s) => s.kind === "loop").map((s) => s.id)

export interface TemplateLoopHint {
  step_plan?: readonly { step_id: string; state: string }[] | null
}

/**
 * Suy profile từ Spine + `TemplateProfile.step_plan`: template vòng S-5 mà mẫu không có mục để soạn (`step_plan` đánh dấu
 * `hidden`, hoặc mọi step đã có `S-5.n@<màn>` đều `skipped`). Nhờ đọc cả `step_plan`, lúc ở B-2.3 và S-4.1 (chưa sinh
 * `S-5.n@<màn>`) vẫn đếm đúng 4 bước/màn cho mẫu không có Screen Layout (FLF-466 P08).
 */
export const screenLoopProfile = (spine: Pick<Spine, "steps">, templateProfile?: TemplateLoopHint | null): ScreenLoopProfile => {
  const loopIds = new Set(loopTemplateIds())
  const byTemplate = new Map<string, boolean>()
  for (const step of spine.steps) {
    const { base, loop } = parseStepId(step.id)
    if (loop === null) continue
    byTemplate.set(base, (byTemplate.get(base) ?? true) && step.status === "skipped")
  }
  const skipped = new Set([...byTemplate].filter(([, allSkipped]) => allSkipped).map(([id]) => id))
  for (const item of templateProfile?.step_plan ?? []) {
    if (item.state === "hidden" && loopIds.has(item.step_id)) skipped.add(item.step_id)
  }
  return { skippedTemplates: skipped }
}

/** Template vòng màn áp dụng cho mẫu đích (theo thứ tự registry). */
export const loopTemplatesOf = (profile: ScreenLoopProfile = FULL_SCREEN_LOOP): string[] => loopTemplateIds().filter((id) => !profile.skippedTemplates.has(id))

/** Số step mỗi màn theo cấu trúc đích: 5 với mẫu chuẩn, 4 khi mẫu không có Screen Layout. */
export const stepsPerScreen = (profile: ScreenLoopProfile = FULL_SCREEN_LOOP): number => loopTemplatesOf(profile).length

export interface StepProgress {
  done: number
  total: number
  current_phase: string | null
  current_step: string | null
  show_percent: boolean
}

/**
 * Thanh tiến độ đếm step: `50 + 5 × N`, N = số màn **chưa để lại** + 1 nếu có non-screen function; trừ step
 * `skipped` (FLF-183). Màn `placeholder` là màn đã quyết định để lại — `nextStep` vốn đã bỏ qua vòng của nó, nên
 * đếm vào mẫu số chỉ làm tiến độ sai: project mode 1 import ra 61 màn placeholder hiện "38/366" trong khi việc
 * thật chỉ ~56 bước (2026-09-20). Màn có function trở lại (`detail_status` khác placeholder) thì đếm như thường.
 * Chỉ đếm step còn trong registry: Spine cũ có thể còn `B-0.4` (đã bỏ ở FLF-221) trong `steps[]`.
 */
export const progressByStep = (spine: Spine): StepProgress => {
  const counted = spine.screens.filter((s) => s.detail_status !== "placeholder").length
  const n = counted + (spine.functions.some((f) => f.screen_id === null) ? 1 : 0)
  const steps = spine.steps.filter((s) => isRegisteredStep(s.id))
  return {
    done: steps.filter((s) => s.status === "accepted").length,
    total: FIXED_STEP_COUNT + STEPS_PER_SCREEN_LOOP * n - steps.filter((s) => s.status === "skipped").length,
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
