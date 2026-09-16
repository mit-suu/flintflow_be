/**
 * run-s9-step.ts
 * ─────────────────────────────────────────────────────────────────
 * Điều phối pha S-9 cho `step-runner.runStep` (Phases §6.4, §6.5). Tách khỏi runner để runner chỉ có
 * đúng một nhánh `if (phase === "S-9")`, và để từng bước S-9 test được riêng.
 *
 * | Step | Gọi model | Meter | Việc |
 * | --- | --- | --- | --- |
 * | S-9.1 Completeness & Assumption Sweep | không | không | quét tất định `atBaseline`, gom giả định, báo glossary lạc hậu |
 * | S-9.2 Quality Lens Run | chỉ khi `REVIEW_LLM_ENABLED` | — | hoãn (Phases §9.1) |
 * | S-9.3 Business Goal Validation | có | có | cờ vàng `goal_not_covered`, không chặn |
 * | S-9.4 Requirement Prioritization | có | có | MoSCoW vào `functions[]/nfrs[].priority` |
 * | S-9.5 Baseline Sign-off | không | không | chỉ quét lại; ký thật ở `POST /baseline` |
 *
 * S-9.1 và S-9.5 **không Meter** là có chủ đích: hết credit vẫn phải quét được và vẫn phải ký được
 * baseline. Người dùng không nên bị khoá khỏi tài liệu của chính mình vì hết tiền.
 */

import * as meter from "../meter.service.js"
import type { DraftExecutor } from "../draft-to-ops.js"
import { completenessSweep, type SweepResult } from "./completeness-sweep.js"
import { validateGoals, type GoalValidationResult, type ReviewExecutor } from "./goal-validation.js"
import { prioritize, type PrioritizeResult } from "./prioritization.js"

export const S9_PHASE = "S-9"

/** Step S-9 chạy mà không gọi model — không tiêu trần 8 lượt, không cần credit. */
export const S9_FREE_STEPS: ReadonlySet<string> = new Set(["S-9.1", "S-9.5"])

export interface RunS9Deps {
  draftExecutor?: DraftExecutor
  reviewExecutor?: ReviewExecutor
  sessionId?: string | null
}

export interface RunS9Result {
  step_id: string
  sweep?: SweepResult
  goals?: GoalValidationResult
  prioritization?: PrioritizeResult
  /** Step không có việc gì để làm ở đây (S-9.2 khi tắt review LLM). */
  skipped?: boolean
}

/** Bọc một lượt gọi model của S-9 vào meter: reserve trước, finalize/release sau. */
const metered = async <T extends { usage?: { tokens_in: number; tokens_out: number; cost: number; logId: string | null }[] }>(
  projectId: string,
  userId: string,
  stepId: string,
  callKind: string,
  run: () => Promise<T>
): Promise<T> => {
  const reservedId = await meter.reserveCall(projectId, userId, stepId, callKind)
  let result: T
  try {
    result = await run()
  } catch (err) {
    await meter.releaseCall(reservedId)
    throw err
  }

  const entries = result.usage ?? []
  const [first, ...rest] = entries
  if (!first) {
    await meter.releaseCall(reservedId)
    return result
  }
  await meter.finalizeCall(reservedId, { call_kind: callKind, attempt: 1, ...first })
  if (rest.length > 0) {
    await meter.recordUsage(
      projectId,
      userId,
      stepId,
      rest.map((u, i) => ({ call_kind: callKind, attempt: i + 2, ...u }))
    )
  }
  return result
}

/**
 * Chạy phần việc của một step S-9. Bước nào không thuộc S-9 thì bên gọi không nên gọi hàm này.
 * Trả kết quả để runner/test đọc; mọi thay đổi Spine đã được ghi bên trong từng service.
 */
export const runS9Step = async (projectId: string, stepId: string, userId: string, deps: RunS9Deps = {}): Promise<RunS9Result> => {
  const base = stepId.split("@")[0]

  switch (base) {
    case "S-9.1":
      return { step_id: stepId, sweep: await completenessSweep(projectId, userId) }

    case "S-9.2":
      // Quality Lens LLM hoãn (Phases §9.1) — bật lại bằng REVIEW_LLM_ENABLED khi có ngân sách.
      return { step_id: stepId, skipped: true }

    case "S-9.3": {
      const goals = await metered(projectId, userId, stepId, "review", () =>
        validateGoals(projectId, userId, deps.reviewExecutor ? { executor: deps.reviewExecutor } : {}).then((r) => ({ ...r, usage: [] }))
      )
      return { step_id: stepId, goals }
    }

    case "S-9.4": {
      const prioritization = await metered(projectId, userId, stepId, "draft", () =>
        prioritize(projectId, userId, {
          ...(deps.draftExecutor ? { executor: deps.draftExecutor } : {}),
          sessionId: deps.sessionId ?? null
        })
      )
      return { step_id: stepId, prioritization }
    }

    case "S-9.5":
      // Chỉ quét lại để user thấy cờ trước khi ký; việc ký thật là `POST /projects/:id/baseline`.
      return { step_id: stepId, sweep: await completenessSweep(projectId, userId) }

    default:
      return { step_id: stepId, skipped: true }
  }
}
