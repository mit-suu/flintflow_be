/**
 * run-estimate.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-332 — "Biết trước tốn bao nhiêu credit trước khi AI chạy hàng loạt" (business-flow §2, cổng cứng §1.2).
 *
 * Ước tính cho lượt chạy liền (`POST /phases/:phase/run` chạy hết một đơn vị giai đoạn rồi tự sang đơn vị kế khi mọi bước
 * đều im): mỗi bước còn chờ tính một lượt Draft (riêng S-9.2, S-8.4, S-9.3 theo giá riêng, xem `stepCredits`), mỗi đơn vị giai đoạn chưa
 * phỏng vấn tính một lượt Elicit. Bước tất định và hai bước sổ sách của vòng S-5 không gọi model ⇒ 0. Đây là con số
 * **trước khi chạy** — lượt chạy thật có thể ít hơn (bước im không hỏi, model trả sớm) hoặc nhiều hơn (lô S-5.2 / S-5.4 chia
 * theo 6 function, câu hỏi thêm) nên FE nói "ước tính".
 *
 * FLF-485: lượt chạy đi qua S-4.1 khi Spine chưa có màn thì vòng S-5 nở ra 0 bước ⇒ thiếu hẳn vòng màn hình. Khi đó thêm một
 * đơn vị `S-5` **ước tính** (số màn đoán từ use case / năng lực trong Brief / dải mặc định, xem `estimateScreenCount`), giá lấy
 * cận trên để `credits_total` luôn là con số an toàn. Màn `placeholder` không được đếm (khớp `nextStep`). Bước chia lô
 * (S-5.2, S-5.4, S-7.3) tính đủ số lượt Draft khi Spine đã có function; trước Danh sách màn hình thì chỉ tính 1 lượt, số lô
 * chính xác chỉ có sau bước đó.
 *
 * Hàm thuần `planRunEstimate` để test không cần Mongo; `runEstimate` nạp Spine, giá hành động và ví org.
 */

import { env } from "../../config/env.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost, getOrCreateWallet, resolveWalletOrg } from "../../shared/ai/credit-reservation.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { CreditAckRequired, CreditAckScope, Spine } from "../spine/spine.types.js"
import { briefCoreEntries } from "../spine/brief-core.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { loopTemplatesOf, screenLoopProfile, type ScreenLoopProfile, type TemplateLoopHint } from "../spine/section-status.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { LOOP_PHASE, PHASES, getStep, isPhaseUnit, isRegisteredStep, loadStepRegistry, loopKeys, nextStep, NONSCREEN_LOOP, orderedSteps, type ExpandedStep } from "./step-registry.js"
import { uncoveredScreens } from "./credit-ack.js"
import { PHASES_WITHOUT_INTERVIEW, phaseUnitOf } from "./phase-runner.service.js"
import { LOOP_BOOKKEEPING_TEMPLATES, functionBatches } from "./step-runner.service.js"
import { estimateReviewBatches } from "./s9/ai-review.js"
import { isScaleNote } from "./context-projection.js"
import { VI_PHASE_LABELS } from "../render/labels.js"

export type RunEstimateScope = "unit" | "all"

export interface RunEstimateCosts {
  draft: number
  review: number
  elicit: number
  /** Giá một lượt `CONSISTENCY_PASS` (S-8.4). */
  consistency: number
  /** `QUALITY_LENS_ENABLED` — tắt ⇒ S-9.2 không gọi model, tính 0. */
  qualityLens: boolean
  /** `CONSISTENCY_LLM_ENABLED` — tắt ⇒ S-8.4 không gọi model, tính 0. */
  consistencyLlm: boolean
  /** Hệ số dải số màn trên mỗi đầu vào của S-1 (FLF-466 P08, cấu hình `RUN_ESTIMATE_SCREENS_PER_INPUT_*`). Thiếu ⇒ mặc định. */
  screenFactor?: { min: number; max: number }
}

export const DEFAULT_SCREEN_FACTOR = Object.freeze({ min: 1.5, max: 2.5 })

export interface RunEstimateUnit {
  unit: string
  /** FLF-485 (#18): nhãn cho người dùng — tên màn với `S-5@Sxx`, "Chức năng không có màn" với `S-5@nonscreen`, nhãn giai đoạn với đơn vị khác. FE hiện nhãn này, không hiện mã đơn vị. */
  label: string
  /** Số bước còn chờ trong đơn vị (kể cả bước không gọi model). */
  steps: number
  /** Số bước có gọi model. */
  ai_steps: number
  /** Lượt phỏng vấn mở giai đoạn (0 khi đã phỏng vấn hoặc giai đoạn không phỏng vấn). */
  interview_credits: number
  /** Cận trên (= `credits_max`). */
  credits: number
  /** Cận dưới. Chỉ khác `credits` ở đơn vị S-5 ước tính (chưa có danh sách màn); đơn vị chính xác thì bằng nhau. */
  credits_min: number
  credits_max: number
  /** Khoảng số màn, chỉ có ở đơn vị S-5 ước tính. */
  screens?: { min: number; max: number }
}

export type ScreenEstimateBasis = "use_cases" | "brief" | "default"
export interface ScreenEstimate {
  min: number
  max: number
  basis: ScreenEstimateBasis
}

/** Dải ước tính phần màn sau Approve Brief — chỉ là ước tính, S-4.1 mới chốt số màn (business-flow §2). */
export interface ScreenRange {
  /** Số màn ước tính tối thiểu / tối đa = hệ số × số đầu vào có ở S-1. */
  min: number
  max: number
  /** Credit mỗi màn theo mẫu (Elicit + các step vòng màn gọi model của cấu trúc đích). */
  credits_per_screen: number
  credits_min: number
  credits_max: number
  /** Đầu vào của S-1 dùng để suy dải. */
  inputs: { goals: number; other_requirements: number; feature_notes: number; total: number }
  /** FLF-485: căn cứ của dải — `scale_note` (Brief có ghi chú quy mô "khoảng 35 use case") hoặc `inputs` (đầu vào S-1). */
  basis: "scale_note" | "inputs"
  /** Luôn true: số này là ước tính. */
  estimated: true
}

export interface RunEstimate {
  scope: RunEstimateScope
  /** Chỉ thêm trường (FLF-466 P08): lần báo — `after_brief` | `screens_locked` | `screens_added`; null ⇒ ước tính chạy liền như trước. */
  scope_kind: CreditAckScope | null
  /** Dải số màn + credit phần màn ước tính; chỉ có với `after_brief`. */
  screen_range: ScreenRange | null
  /** Thông báo credit đang chờ xác nhận của dự án (null ⇒ không có). */
  ack_required: CreditAckRequired | null
  /** Bước đầu tiên của lượt chạy (null ⇒ không còn bước nào). */
  from_step: string | null
  units: RunEstimateUnit[]
  steps_total: number
  ai_steps_total: number
  /** Cận trên (= `credits_max`): client cũ chỉ đọc số này vẫn thấy số an toàn. */
  credits_total: number
  credits_min: number
  credits_max: number
  /** `screens` = đã có màn (chính xác); còn lại là khoảng đoán; null khi lượt chạy không đi qua vòng màn hình. */
  screen_estimate: { min: number; max: number; basis: ScreenEstimateBasis | "screens" } | null
  /** Credit khả dụng của ví org sở hữu project (`balance − reserved`); null khi không xác định được ví. */
  available_credits: number | null
}

/** Dải số màn mặc định khi Spine chưa có gì để đoán (BF R32 ví dụ "8–12 màn"; BarberGo 8 use case ra ≥ 9 màn). */
export const DEFAULT_SCREEN_RANGE = Object.freeze({ min: 6, max: 14 })
/** Mục Mô tả màn hình: năng lực Brief (B-1.4) nhắm vào đây được dùng làm căn cứ đoán số màn. */
const SCREEN_ADDENDUM_TARGET = "fixed:3.1.2"

/**
 * Đoán khoảng số màn khi chưa có danh sách màn (không gọi model). Căn cứ theo thứ tự: số use case (đã qua S-3) >
 * số addendum năng lực nhắm `fixed:3.1.2` > dải mặc định. Hệ số chỉnh lại khi có thêm số đo E2E.
 */
export const estimateScreenCount = (spine: Pick<Spine, "use_cases" | "addendum">): ScreenEstimate => {
  const u = spine.use_cases?.length ?? 0
  if (u > 0) {
    const min = Math.max(3, Math.ceil(u * 0.8))
    return { min, max: Math.max(min + 2, Math.ceil(u * 1.5)), basis: "use_cases" }
  }
  const k = (spine.addendum ?? []).filter((a) => a.target_section === SCREEN_ADDENDUM_TARGET).length
  if (k > 0) {
    const min = Math.max(4, k)
    return { min, max: Math.max(min + 4, Math.ceil(k * 2)), basis: "brief" }
  }
  return { ...DEFAULT_SCREEN_RANGE, basis: "default" }
}

const PENDING_STATUSES = new Set(["pending", "in_progress", "revision_requested"])

const stepCallsModel = (step: ExpandedStep): boolean => !step.deterministic && !LOOP_BOOKKEEPING_TEMPLATES.has(step.template_id)

/**
 * Credit của một bước có gọi model (FLF-449 việc 5, 6):
 * - S-9.2 Soát chất lượng: `review` × số lô của Spine hiện tại (tối thiểu 1); cờ env tắt ⇒ 0.
 * - S-8.4 Rà nhất quán: `consistency` × số lô; cờ env tắt ⇒ 0.
 * - S-9.3 Đối chiếu mục tiêu: gọi REVIEW một lượt nên tính `review`. Dù `project.goals` rỗng thì bước bỏ qua, ở đây vẫn tính
 *   vì lúc ước tính mục tiêu có thể chưa được chốt (ước tính, không phải hoá đơn).
 * - Bước khác: một lượt Draft mỗi lô (FLF-485: bước chia lô theo function gọi model mỗi lô một lượt; chỉ đếm được khi
 *   Spine đã có function).
 * Số lô lấy trên Spine lúc ước tính (sau Approve Brief còn ít phần tử nên thường là 1).
 */
export const stepCredits = (step: ExpandedStep, spine: Spine, costs: RunEstimateCosts): number => {
  switch (step.template_id) {
    case "S-9.2":
      return costs.qualityLens ? costs.review * estimateReviewBatches(spine, "quality") : 0
    case "S-8.4":
      return costs.consistencyLlm ? costs.consistency * estimateReviewBatches(spine, "consistency") : 0
    case "S-9.3":
      return costs.review
    default:
      return costs.draft * Math.max(1, functionBatches(spine, step.id).length)
  }
}

/** Đơn vị đã phỏng vấn: có quyết định còn hiệu lực ghi dưới id đơn vị (cùng dấu `runPhaseInterview` đọc). */
const unitInterviewed = (spine: Spine, unit: string): boolean => spine.decisions.some((d) => d.step_id === unit && d.superseded_by === null)

const FIRST_SRS_PHASE_INDEX = (PHASES as readonly string[]).indexOf("S-2")

/** Nhãn người dùng đọc được của một đơn vị giai đoạn (FLF-485 #18). */
const unitLabel = (spine: Pick<Spine, "screens">, unit: string): string => {
  const [phase, loop] = unit.split("@")
  if (loop === undefined) return VI_PHASE_LABELS[phase] ?? unit
  if (loop === NONSCREEN_LOOP) return "Chức năng không có màn"
  return spine.screens.find((sc) => sc.id === loop)?.name ?? unit
}

/** Đếm đơn vị giai đoạn của danh sách step (dùng chung cho mọi phạm vi). */
const tallyUnits = (spine: Spine, counted: readonly ExpandedStep[], costs: RunEstimateCosts): RunEstimateUnit[] => {
  const units: RunEstimateUnit[] = []
  for (const step of counted) {
    const unit = phaseUnitOf(step)
    let entry = units.find((u) => u.unit === unit)
    if (!entry) {
      const interview = PHASES_WITHOUT_INTERVIEW.has(unit) || unitInterviewed(spine, unit) ? 0 : costs.elicit
      entry = { unit, label: unitLabel(spine, unit), steps: 0, ai_steps: 0, interview_credits: interview, credits: interview, credits_min: interview, credits_max: interview }
      units.push(entry)
    }
    entry.steps += 1
    const credits = stepCallsModel(step) ? stepCredits(step, spine, costs) : 0
    if (credits > 0) {
      entry.ai_steps += 1
      entry.credits += credits
    }
  }
  for (const u of units) {
    // Đơn vị vòng màn (`S-5@Sxx`): cộng phụ trội thử lại đo được (xem `SCREEN_LOOP_OVERHEAD`).
    if (u.unit.startsWith(`${LOOP_PHASE}@`)) u.credits = withLoopOverhead(u.credits)
    u.credits_min = u.credits
    u.credits_max = u.credits
  }
  return units
}

/**
 * FLF-485 (#23): hệ số phụ trội của vòng màn hình so với giá niêm yết (Elicit + Draft x step). Giá niêm yết không tính lượt thử lại
 * (AI trả kết quả không hợp lệ sau 3 lần thử => mất ~12 credit/lần), lượt hỏi lại và phần lô S-5.2 / S-5.4.
 * Số đo E2E nha khoa 26/11 (một dự án, 34 use case, 32 đơn vị vòng màn): 12 màn đầu 211 credit ~ 17,6/màn; 22 màn sau + chức năng
 * không màn + lệnh thu hẹp ~ 20/màn; niêm yết 13/màn => thực tế gấp ~1,35-1,55. Chọn 1,5 (13 -> 20). Chỉnh lại sau lượt E2E 10-15 use case.
 */
export const SCREEN_LOOP_OVERHEAD = 1.5
const withLoopOverhead = (credits: number): number => Math.ceil(credits * SCREEN_LOOP_OVERHEAD)

/** Step vòng màn không áp dụng cho cấu trúc đích (mẫu không có Screen Layout ⇒ không S-5.3) thì không tính credit. */
const applicableToProfile = (step: ExpandedStep, profile: ScreenLoopProfile): boolean => step.loop === null || !profile.skippedTemplates.has(step.template_id)

/**
 * Credit mỗi màn theo mẫu = lượt Elicit mở giai đoạn + mỗi step vòng màn có gọi model của cấu trúc đích × Draft.
 * Step ghi sổ (S-5.1, S-5.5) tính 0. `stepsPerScreen(profile)` ⇒ 5 (mẫu chuẩn) hoặc 4 (mẫu không có Screen Layout).
 */
export const creditsPerScreen = (costs: RunEstimateCosts, profile: ScreenLoopProfile): number => {
  const aiSteps = loopTemplatesOf(profile).filter((id) => !LOOP_BOOKKEEPING_TEMPLATES.has(id)).length
  return withLoopOverhead(costs.elicit + aiSteps * costs.draft)
}

const FEATURE_NOTE_TOPIC = /feature|tính năng|chức năng|capabilit|mvp|phạm vi|scope|module/iu

const UC_NOTE = /(\d+)\s*(?:(?:-|–|~|đến|tới|to)\s*(\d+)\s*)?(?:use[\s-]?cases?\b|uc\b)/iu

/** Số use case ghi trong ghi chú quy mô của Brief ("khoảng 35 use case", "5-8 use case"); không có => null. Lấy ghi chú nêu số lớn nhất. */
const scaleNoteUseCases = (spine: Spine): { lo: number; hi: number } | null => {
  let best: { lo: number; hi: number } | null = null
  for (const a of spine.addendum) {
    if (!isScaleNote(a)) continue
    const m = UC_NOTE.exec(a.content) ?? UC_NOTE.exec(a.content_en ?? "")
    if (!m) continue
    const lo = Number(m[1])
    const hi = m[2] ? Math.max(lo, Number(m[2])) : lo
    if (hi > 0 && (!best || hi > best.hi)) best = { lo, hi }
  }
  return best
}

/**
 * Dải số màn sau Approve Brief. FLF-485 (#9): Brief có ghi chú quy mô theo use case => `số UC x (0,8...1,5)` như `estimateScreenCount`
 * (35 UC => 28-53 màn). Không có => hệ số cấu hình x số đầu vào có ở S-1: mục tiêu (addendum lõi hoặc `project.goals`) và mục addendum
 * dạng tính năng. `other_requirements` (câu hỏi mở) KHÔNG tính: câu hỏi mở không sinh màn. Là ước tính; S-4.1 mới chốt số màn.
 */
export const estimateScreenRange = (spine: Spine, costs: RunEstimateCosts, profile: ScreenLoopProfile): ScreenRange => {
  const core = briefCoreEntries(spine)
  const goals = Math.max(core.goals.length, spine.project.goals.length)
  const featureNotes = spine.addendum.filter(
    (a) => a !== core.vision && !core.goals.includes(a) && (FEATURE_NOTE_TOPIC.test(a.topic) || a.target_section.startsWith("feature:"))
  ).length
  const inputs = { goals, other_requirements: spine.other_requirements.length, feature_notes: featureNotes, total: 0 }
  inputs.total = inputs.goals + inputs.feature_notes
  const perScreen = creditsPerScreen(costs, profile)
  const scale = scaleNoteUseCases(spine)
  if (scale) {
    const min = Math.max(1, Math.ceil(scale.lo * 0.8))
    const max = Math.max(min, Math.ceil(scale.hi * 1.5))
    return { min, max, credits_per_screen: perScreen, credits_min: min * perScreen, credits_max: max * perScreen, inputs, basis: "scale_note", estimated: true }
  }
  const factor = costs.screenFactor ?? DEFAULT_SCREEN_FACTOR
  const min = inputs.total === 0 ? 0 : Math.max(1, Math.floor(inputs.total * factor.min))
  const max = inputs.total === 0 ? 0 : Math.max(min, Math.ceil(inputs.total * factor.max))
  return { min, max, credits_per_screen: perScreen, credits_min: min * perScreen, credits_max: max * perScreen, inputs, basis: "inputs", estimated: true }
}

export interface RunEstimateQuery {
  scope: RunEstimateScope
  from?: string | null
  /** Lần báo cần tính (FLF-466 P08). Thiếu ⇒ theo `progress.credit_ack_required` nếu có, không thì ước tính chạy liền như FLF-332. */
  scope_kind?: CreditAckScope | null
  /** `screens_added`: màn của lần báo; thiếu ⇒ màn chưa được báo credit. */
  screens?: readonly string[]
}

/**
 * `from`: id bước hoặc đơn vị giai đoạn để bắt đầu đếm; thiếu ⇒ bước tới lượt (`nextStep`). Bước đã accepted / skipped không
 * tính. Scope `unit` chỉ đếm đơn vị của bước đầu; `all` đếm tới hết pipeline.
 *
 * `scope_kind` (FLF-466 P08) đổi tập step đếm, bỏ qua `scope` / `from`:
 *   - `after_brief`: mọi step từ S-2 TRỪ vòng màn (chính xác) + `screen_range` ước tính phần màn;
 *   - `screens_locked`: vòng màn của mọi màn đã chốt ở S-4.1 (chính xác);
 *   - `screens_added`: vòng màn của các màn thêm sau S-4.1.
 */
export const planRunEstimate = (
  spine: Spine,
  query: RunEstimateQuery,
  costs: RunEstimateCosts,
  templateProfile?: TemplateLoopHint | null
): Omit<RunEstimate, "available_credits"> => {
  const all = orderedSteps(spine)
  const statusOf = (id: string): string => spine.steps.find((s) => s.id === id)?.status ?? "pending"
  const profile = screenLoopProfile(spine, templateProfile)
  const ack = spine.progress.credit_ack_required ?? null
  const kind = query.scope_kind ?? ack?.scope ?? null

  // FLF-458: lần báo đọc tài liệu tham khảo ở B-0 — số credit đã tính sẵn trong lần báo, không đếm step
  if (kind === "reference_documents") {
    const credits = ack?.scope === "reference_documents" ? ack.credits : 0
    return {
      scope: query.scope,
      scope_kind: kind,
      screen_range: null,
      ack_required: ack,
      from_step: null,
      units: [],
      steps_total: 0,
      ai_steps_total: 0,
      credits_total: credits,
      credits_min: credits,
      credits_max: credits,
      screen_estimate: null
    }
  }

  if (kind) {
    const pending = all.filter((s) => PENDING_STATUSES.has(statusOf(s.id)) && applicableToProfile(s, profile))
    let counted: ExpandedStep[]
    if (kind === "after_brief") {
      counted = pending.filter((s) => s.loop === null && s.kind !== "loop" && (PHASES as readonly string[]).indexOf(s.phase) >= FIRST_SRS_PHASE_INDEX)
    } else {
      const placeholders = new Set(spine.screens.filter((s) => s.detail_status === "placeholder").map((s) => s.id))
      const only = kind === "screens_added" ? new Set(query.screens ?? (ack?.scope === "screens_added" ? ack.screens : null) ?? uncoveredScreens(spine)) : null
      counted = pending.filter((s) => s.loop !== null && !placeholders.has(s.loop) && (only === null || only.has(s.loop)))
    }
    const units = tallyUnits(spine, counted, costs)
    const screenRange = kind === "after_brief" ? estimateScreenRange(spine, costs, profile) : null
    // FLF-485 (#9): sau Approve Brief tổng là KHOẢNG gồm cả vòng màn hình ước tính, không chỉ phần ngoài vòng.
    const fixedTotal = units.reduce((n, u) => n + u.credits, 0)
    const creditsMin = fixedTotal + (screenRange?.credits_min ?? 0)
    const creditsMax = fixedTotal + (screenRange?.credits_max ?? 0)
    return {
      scope: query.scope,
      scope_kind: kind,
      screen_range: screenRange,
      ack_required: ack,
      from_step: counted[0]?.id ?? null,
      units,
      steps_total: counted.length,
      ai_steps_total: units.reduce((n, u) => n + u.ai_steps, 0),
      credits_total: creditsMax,
      credits_min: creditsMin,
      credits_max: creditsMax,
      screen_estimate: null
    }
  }

  let startIndex: number
  if (query.from) {
    const from = query.from
    startIndex = isPhaseUnit(from) ? all.findIndex((s) => phaseUnitOf(s) === from) : all.findIndex((s) => s.id === from)
    if (startIndex < 0) throw new ApiError(404, `Không có bước hoặc giai đoạn ${from} trong pipeline.`, "STEP_NOT_FOUND")
  } else {
    const next = nextStep(spine)
    startIndex = next ? all.findIndex((s) => s.id === next.id) : -1
  }
  // Vòng của màn placeholder không tính, giống `nextStep`.
  const placeholders = new Set(spine.screens.filter((s) => s.detail_status === "placeholder").map((s) => s.id))
  const remaining = startIndex < 0 ? [] : all.slice(startIndex).filter((s) => PENDING_STATUSES.has(statusOf(s.id)) && applicableToProfile(s, profile) && !(s.loop !== null && placeholders.has(s.loop)))
  const firstUnit = remaining[0] ? phaseUnitOf(remaining[0]) : null
  const counted = query.scope === "unit" ? remaining.filter((s) => phaseUnitOf(s) === firstUnit) : remaining

  const units = tallyUnits(spine, counted, costs)

  // FLF-485: chưa có màn mà lượt chạy sẽ đi qua S-4.1 ⇒ thêm đơn vị S-5 ước tính (cận trên, cộng một vòng không màn).
  const s5Index = PHASES.indexOf(LOOP_PHASE as (typeof PHASES)[number])
  const s41 = statusOf("S-4.1")
  const passesScreenList =
    query.scope === "all" && loopKeys(spine).length === 0 && s41 !== "accepted" && s41 !== "skipped" && counted.some((s) => PHASES.indexOf(s.phase) < s5Index)
  let screenEstimate: RunEstimate["screen_estimate"] = null
  if (passesScreenList) {
    const loopTemplates = loadStepRegistry().filter((t) => t.kind === "loop")
    const aiPerLoop = loopTemplates.filter((t) => !t.deterministic && !LOOP_BOOKKEEPING_TEMPLATES.has(t.id)).length
    const perScreen = withLoopOverhead(costs.elicit + aiPerLoop * costs.draft)
    const range = estimateScreenCount(spine)
    screenEstimate = range
    const loops = range.max + 1
    const at = units.findIndex((u) => PHASES.indexOf(u.unit.split("@")[0] as (typeof PHASES)[number]) > s5Index)
    const entry: RunEstimateUnit = {
      unit: LOOP_PHASE,
      label: "Vòng màn hình (ước tính)",
      steps: loopTemplates.length * loops,
      ai_steps: aiPerLoop * loops,
      interview_credits: costs.elicit * loops,
      credits: perScreen * loops,
      credits_min: perScreen * range.min,
      credits_max: perScreen * loops,
      screens: { min: range.min, max: range.max }
    }
    units.splice(at < 0 ? units.length : at, 0, entry)
  }
  if (!screenEstimate && units.some((u) => u.unit.startsWith(LOOP_PHASE))) {
    const n = spine.screens.filter((sc) => sc.detail_status !== "placeholder").length
    screenEstimate = { min: n, max: n, basis: "screens" }
  }
  return {
    scope: query.scope,
    scope_kind: null,
    screen_range: null,
    ack_required: null,
    from_step: remaining[0]?.id ?? null,
    units,
    steps_total: units.reduce((n, u) => n + u.steps, 0),
    ai_steps_total: units.reduce((n, u) => n + u.ai_steps, 0),
    credits_total: units.reduce((n, u) => n + u.credits_max, 0),
    credits_min: units.reduce((n, u) => n + u.credits_min, 0),
    credits_max: units.reduce((n, u) => n + u.credits_max, 0),
    screen_estimate: screenEstimate
  }
}

/** Giá hành động + hệ số dải màn từ cấu hình (dùng chung `runEstimate` và `credit-ack.service`). */
export const loadRunEstimateCosts = async (): Promise<RunEstimateCosts> => {
  const [draft, review, elicit, consistency] = await Promise.all([
    getActionCost(ActionType.DRAFT),
    getActionCost(ActionType.REVIEW),
    getActionCost(ActionType.ELICIT),
    getActionCost(ActionType.CONSISTENCY_PASS)
  ])
  const min = env.RUN_ESTIMATE_SCREENS_PER_INPUT_MIN
  return {
    draft,
    review,
    elicit,
    consistency,
    qualityLens: env.QUALITY_LENS_ENABLED,
    consistencyLlm: env.CONSISTENCY_LLM_ENABLED,
    screenFactor: { min, max: Math.max(min, env.RUN_ESTIMATE_SCREENS_PER_INPUT_MAX) }
  }
}

export const runEstimate = async (projectId: string, userId: string, query: RunEstimateQuery): Promise<RunEstimate> => {
  if (query.from && !isRegisteredStep(query.from) && !isPhaseUnit(query.from)) {
    throw new ApiError(404, `Không có bước hoặc giai đoạn ${query.from} trong pipeline.`, "STEP_NOT_FOUND")
  }
  if (query.from && isRegisteredStep(query.from)) getStep(query.from)
  const [record, templateProfile] = await Promise.all([
    spineRepository.get(projectId),
    TemplateProfile.db.readyState === 1 ? TemplateProfile.findOne({ projectId }).select("step_plan").lean() : Promise.resolve(null)
  ])
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const { projectId: _p, ...spine } = record
  const plan = planRunEstimate(spine as Spine, query, await loadRunEstimateCosts(), templateProfile)
  const orgId = await resolveWalletOrg(projectId)
  if (!orgId) return { ...plan, available_credits: null }
  const wallet = await getOrCreateWallet(userId, undefined, orgId)
  return { ...plan, available_credits: wallet.balance - wallet.reserved }
}
