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
import type { Spine } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { getStep, isPhaseUnit, isRegisteredStep, nextStep, orderedSteps, type ExpandedStep } from "./step-registry.js"
import { PHASES_WITHOUT_INTERVIEW, phaseUnitOf } from "./phase-runner.service.js"
import { LOOP_BOOKKEEPING_TEMPLATES } from "./step-runner.service.js"

export type RunEstimateScope = "unit" | "all"

export interface RunEstimateCosts {
  draft: number
  review: number
  elicit: number
  /** `REVIEW_LLM_ENABLED` — mặc định tắt: Review chỉ là kiểm tất định, không tốn credit. */
  reviewLlm: boolean
}

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

export interface RunEstimate {
  scope: RunEstimateScope
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
  const remaining = startIndex < 0 ? [] : all.slice(startIndex).filter((s) => PENDING_STATUSES.has(statusOf(s.id)))
  const firstUnit = remaining[0] ? phaseUnitOf(remaining[0]) : null
  const counted = query.scope === "unit" ? remaining.filter((s) => phaseUnitOf(s) === firstUnit) : remaining

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
  return {
    scope: query.scope,
    from_step: remaining[0]?.id ?? null,
    units,
    steps_total: counted.length,
    ai_steps_total: units.reduce((n, u) => n + u.ai_steps, 0),
    credits_total: units.reduce((n, u) => n + u.credits, 0)
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
  const [draft, review, elicit] = await Promise.all([getActionCost(ActionType.DRAFT), getActionCost(ActionType.REVIEW), getActionCost(ActionType.ELICIT)])
  const plan = planRunEstimate(spine as Spine, query, { draft, review, elicit, reviewLlm: env.REVIEW_LLM_ENABLED })
  const orgId = await resolveWalletOrg(projectId)
  if (!orgId) return { ...plan, available_credits: null }
  const wallet = await getOrCreateWallet(userId, undefined, orgId)
  return { ...plan, available_credits: wallet.balance - wallet.reserved }
}
