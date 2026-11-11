import { describe, expect, it, vi } from "vitest"

const executeAiAction = vi.hoisted(() => vi.fn(async () => ({ data: { ops: [] } })))
vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction }))

import { ActionType } from "../../shared/ai/ai-action.types.js"
import { defaultStepRunnerDeps } from "./step-runner.service.js"

describe("defaultStepRunnerDeps - executor thật của step runner", () => {
  it("draft chuyển tiếp tuỳ chọn của draftOps (minMaxTokens) kèm signal huỷ lượt", async () => {
    const controller = new AbortController()
    await defaultStepRunnerDeps(controller.signal).draftExecutor(ActionType.DRAFT, { promptVariables: {} }, "p", "u", { minMaxTokens: 16384 })
    expect(executeAiAction).toHaveBeenCalledWith(ActionType.DRAFT, { promptVariables: {} }, "p", "u", { minMaxTokens: 16384, signal: controller.signal })
  })
})
