/**
 * run-estimate.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-332 — "Biết trước tốn bao nhiêu credit trước khi AI chạy hàng loạt" (business-flow §2, cổng cứng §1.2).
 *
 * Ước tính cho lượt chạy liền (`POST /phases/:phase/run` chạy hết một đơn vị giai đoạn rồi tự sang đơn vị kế khi mọi bước
 * đều im): mỗi bước còn chờ tính một lượt Draft (+ một lượt Review nếu `REVIEW_LLM_ENABLED`), mỗi đơn vị giai đoạn chưa
 * phỏng vấn tính một lượt Elicit. Bước tất định và hai bước sổ sách của vòng S-5 không gọi model ⇒ 0. Đây là con số
 * **trước khi chạy** — lượt chạy thật có thể ít hơn (bước im không hỏi, model trả sớm) hoặc nhiều hơn (lô S-5.2 / S-5.4 chia
 * theo 6 function, câu hỏi thêm) nên FE nói "ước tính".
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
import { PHASES, getStep, isPhaseUnit, isRegisteredStep, nextStep, orderedSteps, type ExpandedStep } from "./step-registry.js"
import { uncoveredScreens } from "./credit-ack.js"
import { PHASES_WITHOUT_INTERVIEW, phaseUnitOf } from "./phase-runner.service.js"
import { LOOP_BOOKKEEPING_TEMPLATES } from "./step-runner.service.js"

export type RunEstimateScope = "unit" | "all"

export interface RunEstimateCosts {
  draft: number
  review: number
  elicit: number
  /** `REVIEW_LLM_ENABLED` — mặc định tắt: Review chỉ là kiểm tất định, không tốn credit. */
  reviewLlm: boolean
  /** Hệ số dải số màn trên mỗi đầu vào của S-1 (FLF-466 P08, cấu hình `RUN_ESTIMATE_SCREENS_PER_INPUT_*`). Thiếu ⇒ mặc định. */
  screenFactor?: { min: number; max: number }
}

export const DEFAULT_SCREEN_FACTOR = Object.freeze({ min: 1.5, max: 2.5 })

export interface RunEstimateUnit {
  unit: string
  /** Số bước còn chờ trong đơn vị (kể cả bước không gọi model). */
  steps: number
  /** Số bước có gọi model. */
  ai_steps: number
  /** Lượt phỏng vấn mở giai đoạn (0 khi đã phỏng vấn hoặc giai đoạn không phỏng vấn). */
  interview_credits: number
  credits: number
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
  credits_total: number
  /** Credit khả dụng của ví org sở hữu project (`balance − reserved`); null khi không xác định được ví. */
  available_credits: number | null
}

const PENDING_STATUSES = new Set(["pending", "in_progress", "revision_requested"])

const stepCallsModel = (step: ExpandedStep): boolean => !step.deterministic && !LOOP_BOOKKEEPING_TEMPLATES.has(step.template_id)

/** Đơn vị đã phỏng vấn: có quyết định còn hiệu lực ghi dưới id đơn vị (cùng dấu `runPhaseInterview` đọc). */
const unitInterviewed = (spine: Spine, unit: string): boolean => spine.decisions.some((d) => d.step_id === unit && d.superseded_by === null)

const FIRST_SRS_PHASE_INDEX = (PHASES as readonly string[]).indexOf("S-2")

/** Đếm đơn vị giai đoạn của danh sách step (dùng chung cho mọi phạm vi). */
const tallyUnits = (spine: Spine, counted: readonly ExpandedStep[], costs: RunEstimateCosts): RunEstimateUnit[] => {
  const units: RunEstimateUnit[] = []
  for (const step of counted) {
    const unit = phaseUnitOf(step)
    let entry = units.find((u) => u.unit === unit)
    if (!entry) {
      const interview = PHASES_WITHOUT_INTERVIEW.has(unit) || unitInterviewed(spine, unit) ? 0 : costs.elicit
      entry = { unit, steps: 0, ai_steps: 0, interview_credits: interview, credits: interview }
      units.push(entry)
    }
    entry.steps += 1
    if (stepCallsModel(step)) {
      entry.ai_steps += 1
      entry.credits += costs.draft + (costs.reviewLlm ? costs.review : 0)
    }
  }
  return units
}

/** Step vòng màn không áp dụng cho cấu trúc đích (mẫu không có Screen Layout ⇒ không S-5.3) thì không tính credit. */
const applicableToProfile = (step: ExpandedStep, profile: ScreenLoopProfile): boolean => step.loop === null || !profile.skippedTemplates.has(step.template_id)

/**
 * Credit mỗi màn theo mẫu = lượt Elicit mở giai đoạn + mỗi step vòng màn có gọi model của cấu trúc đích × (Draft [+ Review]).
 * Step ghi sổ (S-5.1, S-5.5) tính 0. `stepsPerScreen(profile)` ⇒ 5 (mẫu chuẩn) hoặc 4 (mẫu không có Screen Layout).
 */
export const creditsPerScreen = (costs: RunEstimateCosts, profile: ScreenLoopProfile): number => {
  const aiSteps = loopTemplatesOf(profile).filter((id) => !LOOP_BOOKKEEPING_TEMPLATES.has(id)).length
  return costs.elicit + aiSteps * (costs.draft + (costs.reviewLlm ? costs.review : 0))
}

const FEATURE_NOTE_TOPIC = /feature|tính năng|chức năng|capabilit|mvp|phạm vi|scope|module/iu

/**
 * Dải số màn sau Approve Brief = hệ số cấu hình × số đầu vào có ở S-1: mục tiêu (addendum lõi hoặc `project.goals`),
 * `other_requirements`, mục addendum dạng tính năng. Là ước tính; S-4.1 mới chốt số màn.
 */
export const estimateScreenRange = (spine: Spine, costs: RunEstimateCosts, profile: ScreenLoopProfile): ScreenRange => {
  const core = briefCoreEntries(spine)
  const goals = Math.max(core.goals.length, spine.project.goals.length)
  const featureNotes = spine.addendum.filter(
    (a) => a !== core.vision && !core.goals.includes(a) && (FEATURE_NOTE_TOPIC.test(a.topic) || a.target_section.startsWith("feature:"))
  ).length
  const inputs = { goals, other_requirements: spine.other_requirements.length, feature_notes: featureNotes, total: 0 }
  inputs.total = inputs.goals + inputs.other_requirements + inputs.feature_notes
  const factor = costs.screenFactor ?? DEFAULT_SCREEN_FACTOR
  const min = inputs.total === 0 ? 0 : Math.max(1, Math.floor(inputs.total * factor.min))
  const max = inputs.total === 0 ? 0 : Math.max(min, Math.ceil(inputs.total * factor.max))
  const perScreen = creditsPerScreen(costs, profile)
  return { min, max, credits_per_screen: perScreen, credits_min: min * perScreen, credits_max: max * perScreen, inputs, estimated: true }
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
    return {
      scope: query.scope,
      scope_kind: kind,
      screen_range: kind === "after_brief" ? estimateScreenRange(spine, costs, profile) : null,
      ack_required: ack,
      from_step: counted[0]?.id ?? null,
      units,
      steps_total: counted.length,
      ai_steps_total: units.reduce((n, u) => n + u.ai_steps, 0),
      credits_total: units.reduce((n, u) => n + u.credits, 0)
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
  const remaining = startIndex < 0 ? [] : all.slice(startIndex).filter((s) => PENDING_STATUSES.has(statusOf(s.id)) && applicableToProfile(s, profile))
  const firstUnit = remaining[0] ? phaseUnitOf(remaining[0]) : null
  const counted = query.scope === "unit" ? remaining.filter((s) => phaseUnitOf(s) === firstUnit) : remaining

  const units = tallyUnits(spine, counted, costs)
  return {
    scope: query.scope,
    scope_kind: null,
    screen_range: null,
    ack_required: null,
    from_step: remaining[0]?.id ?? null,
    units,
    steps_total: counted.length,
    ai_steps_total: units.reduce((n, u) => n + u.ai_steps, 0),
    credits_total: units.reduce((n, u) => n + u.credits, 0)
  }
}

/** Giá hành động + hệ số dải màn từ cấu hình (dùng chung `runEstimate` và `credit-ack.service`). */
export const loadRunEstimateCosts = async (): Promise<RunEstimateCosts> => {
  const [draft, review, elicit] = await Promise.all([getActionCost(ActionType.DRAFT), getActionCost(ActionType.REVIEW), getActionCost(ActionType.ELICIT)])
  const min = env.RUN_ESTIMATE_SCREENS_PER_INPUT_MIN
  return { draft, review, elicit, reviewLlm: env.REVIEW_LLM_ENABLED, screenFactor: { min, max: Math.max(min, env.RUN_ESTIMATE_SCREENS_PER_INPUT_MAX) } }
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
