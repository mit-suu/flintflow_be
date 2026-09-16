/**
 * goal-validation.ts
 * ─────────────────────────────────────────────────────────────────
 * S-9.3 Business Goal Validation (Phases §6.4, UC 6.5): đối chiếu `project.goals[]` với những gì tài
 * liệu thật sự mô tả (`use_cases[]`, `functions[]`). Mục tiêu không được phủ ⇒ cờ **vàng**
 * `goal_not_covered` — **không chặn baseline**. Quyết định bỏ một mục tiêu là việc của người, không phải
 * của một lượt review.
 *
 * Dùng skill `review-section` (ActionType `REVIEW`, output `review` = chỉ cờ vàng) thay vì viết một skill
 * riêng: đúng công cụ, và ràng buộc "chỉ được phát cờ vàng" đã nằm sẵn trong skill đó.
 *
 * `goal_not_covered` nằm trong `MODEL_OWNED_RULES` (`deterministic-check.ts`) nên lượt recompute kế tiếp
 * không tự đóng nó — nếu không thì cờ biến mất trước khi user kịp đọc.
 */

import { applyTransaction } from "../../spine/op-engine.js"
import * as repository from "../../spine/spine.repository.js"
import type { Op } from "../../spine/op.types.js"
import type { Flag, Spine, SpineRecord } from "../../spine/spine.types.js"
import { ActionType, type AiActionInput, type AiActionResult } from "../../../shared/ai/ai-action.types.js"
import { executeAiAction } from "../../../shared/ai/ai-action.service.js"
import type { ReviewOutput } from "../../../shared/ai/response-parser.js"
import { ApiError } from "../../../shared/utils/api-error.js"

export const GOAL_VALIDATION_STEP = "S-9.3"
export const GOAL_NOT_COVERED = "goal_not_covered"

/** Section §1 Product Overview giữ `project.goals[]` — cờ trỏ về đó để user biết sửa ở đâu. */
const GOALS_SECTION = "fixed:1"

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

export type ReviewExecutor = (input: AiActionInput, projectId: string, userId: string) => Promise<AiActionResult<ReviewOutput>>

const defaultExecutor: ReviewExecutor = (input, projectId, userId) => executeAiAction<ReviewOutput>(ActionType.REVIEW, input, projectId, userId)

const nextFlagId = (spine: Pick<Spine, "flags">): (() => string) => {
  let max = spine.flags.reduce((acc, f) => {
    const m = /^FL(\d+)$/.exec(f.id)
    return m ? Math.max(acc, Number(m[1])) : acc
  }, 0)
  return () => `FL${String(++max).padStart(3, "0")}`
}

export interface GoalValidationOptions {
  executor?: ReviewExecutor
}

export interface GoalValidationResult {
  spine_version: number
  /** Cờ vàng vừa mở trong lượt này. */
  opened: string[]
  /** Mục tiêu model cho là chưa được phủ, nguyên văn message. */
  uncovered: string[]
  /** Không có `project.goals[]` thì không có gì để đối chiếu — bỏ qua, không gọi model. */
  skipped: boolean
}

/**
 * Chạy S-9.3. Không ném khi model trả rỗng — "mọi mục tiêu đều được phủ" là kết quả hợp lệ.
 * Cờ đã mở cho cùng một mục tiêu không bị nhân đôi ở lượt chạy lại.
 */
export const validateGoals = async (projectId: string, userId: string, options: GoalValidationOptions = {}): Promise<GoalValidationResult> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)

  if (spine.project.goals.length === 0) {
    return { spine_version: record.spine_version, opened: [], uncovered: [], skipped: true }
  }

  const execute = options.executor ?? defaultExecutor
  const result = await execute(
    {
      promptVariables: {
        call_kind: "review",
        step_id: GOAL_VALIDATION_STEP,
        lenses: "business goal coverage — every goal must be traceable to at least one use case or function",
        section_ids: [GOALS_SECTION],
        projection: {
          "project:name,vision,goals": { name: spine.project.name, vision: spine.project.vision, goals: spine.project.goals },
          "use_cases:id,name,description": spine.use_cases.map(({ id, name, description }) => ({ id, name, description })),
          "functions:id,name,feature_id": spine.functions.map(({ id, name, feature_id }) => ({ id, name, feature_id }))
        },
        business_goals: spine.project.goals,
        glossary: spine.glossary.map(({ id, term, definition }) => ({ id, term, definition })),
        open_flags: spine.flags.filter((f) => f.resolved_at === null).map(({ rule_id, section_id, message }) => ({ rule_id, section_id, message }))
      }
    },
    projectId,
    userId
  )

  // Chỉ nhận cờ vàng: skill đã cấm cờ đỏ, nhưng không tin output — lọc lại ở code.
  const candidates = (result.data.flags ?? []).filter((f) => f.level === "yellow" && f.message.trim().length > 0)
  const alreadyOpen = new Set(
    spine.flags.filter((f) => f.rule_id === GOAL_NOT_COVERED && f.resolved_at === null).map((f) => f.message.trim())
  )
  const fresh = candidates.filter((f) => !alreadyOpen.has(f.message.trim()))

  if (fresh.length === 0) {
    return { spine_version: record.spine_version, opened: [], uncovered: candidates.map((f) => f.message), skipped: false }
  }

  const nextId = nextFlagId(spine)
  const ops: Op[] = fresh.map((candidate) => {
    const flag: Flag = {
      id: nextId(),
      level: "yellow",
      rule_id: GOAL_NOT_COVERED,
      section_id: GOALS_SECTION,
      target_id: null,
      message: candidate.message.trim(),
      remediation_step: GOAL_VALIDATION_STEP,
      opened_at_version: record.spine_version + 1,
      resolved_at: null,
      waived_by_user: false,
      waive_reason: null,
      waived_at_version: null
    }
    return { op: "add", path: "flags[]", value: flag, reason: "S-9.3: mục tiêu chưa được phủ" }
  })

  const applied = await applyTransaction(projectId, {
    base_version: record.spine_version,
    ops,
    by: userId,
    step_id: GOAL_VALIDATION_STEP,
    reason: "S-9.3 Business Goal Validation"
  })

  return {
    spine_version: applied.spine_version,
    opened: ops.map((op) => (op.value as Flag).id),
    uncovered: candidates.map((f) => f.message),
    skipped: false
  }
}
