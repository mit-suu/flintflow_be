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
import type { Spine } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { LOOP_PHASE, PHASES, getStep, isPhaseUnit, isRegisteredStep, loadStepRegistry, loopKeys, nextStep, orderedSteps, type ExpandedStep } from "./step-registry.js"
import { PHASES_WITHOUT_INTERVIEW, phaseUnitOf } from "./phase-runner.service.js"
import { LOOP_BOOKKEEPING_TEMPLATES, functionBatches } from "./step-runner.service.js"
import { estimateReviewBatches } from "./s9/ai-review.js"

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
}

export interface RunEstimateUnit {
  unit: string
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

export interface RunEstimate {
  scope: RunEstimateScope
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

/**
 * `from`: id bước hoặc đơn vị giai đoạn để bắt đầu đếm; thiếu ⇒ bước tới lượt (`nextStep`). Bước đã accepted / skipped không
 * tính. Scope `unit` chỉ đếm đơn vị của bước đầu; `all` đếm tới hết pipeline.
 */
export const planRunEstimate = (spine: Spine, query: { scope: RunEstimateScope; from?: string | null }, costs: RunEstimateCosts): Omit<RunEstimate, "available_credits"> => {
  const all = orderedSteps(spine)
  const statusOf = (id: string): string => spine.steps.find((s) => s.id === id)?.status ?? "pending"
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
  const remaining = startIndex < 0 ? [] : all.slice(startIndex).filter((s) => PENDING_STATUSES.has(statusOf(s.id)) && !(s.loop !== null && placeholders.has(s.loop)))
  const firstUnit = remaining[0] ? phaseUnitOf(remaining[0]) : null
  const counted = query.scope === "unit" ? remaining.filter((s) => phaseUnitOf(s) === firstUnit) : remaining

  const units: RunEstimateUnit[] = []
  for (const step of counted) {
    const unit = phaseUnitOf(step)
    let entry = units.find((u) => u.unit === unit)
    if (!entry) {
      const interview = PHASES_WITHOUT_INTERVIEW.has(unit) || unitInterviewed(spine, unit) ? 0 : costs.elicit
      entry = { unit, steps: 0, ai_steps: 0, interview_credits: interview, credits: interview, credits_min: interview, credits_max: interview }
      units.push(entry)
    }
    entry.steps += 1
    const credits = stepCallsModel(step) ? stepCredits(step, spine, costs) : 0
    if (credits > 0) {
      entry.ai_steps += 1
      entry.credits += credits
    }
  }
  // Đơn vị chính xác: cận dưới = cận trên = credits.
  for (const u of units) {
    u.credits_min = u.credits
    u.credits_max = u.credits
  }

  // FLF-485: chưa có màn mà lượt chạy sẽ đi qua S-4.1 ⇒ thêm đơn vị S-5 ước tính (cận trên, cộng một vòng không màn).
  const s5Index = PHASES.indexOf(LOOP_PHASE as (typeof PHASES)[number])
  const s41 = statusOf("S-4.1")
  const passesScreenList =
    query.scope === "all" && loopKeys(spine).length === 0 && s41 !== "accepted" && s41 !== "skipped" && counted.some((s) => PHASES.indexOf(s.phase) < s5Index)
  let screenEstimate: RunEstimate["screen_estimate"] = null
  if (passesScreenList) {
    const loopTemplates = loadStepRegistry().filter((t) => t.kind === "loop")
    const aiPerLoop = loopTemplates.filter((t) => !t.deterministic && !LOOP_BOOKKEEPING_TEMPLATES.has(t.id)).length
    const perScreen = costs.elicit + aiPerLoop * costs.draft
    const range = estimateScreenCount(spine)
    screenEstimate = range
    const loops = range.max + 1
    const at = units.findIndex((u) => PHASES.indexOf(u.unit.split("@")[0] as (typeof PHASES)[number]) > s5Index)
    const entry: RunEstimateUnit = {
      unit: LOOP_PHASE,
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

export const runEstimate = async (projectId: string, userId: string, query: { scope: RunEstimateScope; from?: string | null }): Promise<RunEstimate> => {
  if (query.from && !isRegisteredStep(query.from) && !isPhaseUnit(query.from)) {
    throw new ApiError(404, `Không có bước hoặc giai đoạn ${query.from} trong pipeline.`, "STEP_NOT_FOUND")
  }
  if (query.from && isRegisteredStep(query.from)) getStep(query.from)
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const { projectId: _p, ...spine } = record
  const [draft, review, elicit, consistency] = await Promise.all([
    getActionCost(ActionType.DRAFT),
    getActionCost(ActionType.REVIEW),
    getActionCost(ActionType.ELICIT),
    getActionCost(ActionType.CONSISTENCY_PASS)
  ])
  const plan = planRunEstimate(spine as Spine, query, {
    draft,
    review,
    elicit,
    consistency,
    qualityLens: env.QUALITY_LENS_ENABLED,
    consistencyLlm: env.CONSISTENCY_LLM_ENABLED
  })
  const orgId = await resolveWalletOrg(projectId)
  if (!orgId) return { ...plan, available_credits: null }
  const wallet = await getOrCreateWallet(userId, undefined, orgId)
  return { ...plan, available_credits: wallet.balance - wallet.reserved }
}
