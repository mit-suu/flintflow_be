/**
 * `withMeteredAi` (FLF-172, P4 §8.3 `metered-ai.test.ts`; plan §6 2G) — hàm thuần với `executeAiAction` và sổ usage
 * giả: reserve → finalize khi thành công, reserve → release khi lỗi, lý do dừng `credits` / `resume_later`.
 * Retry 2 lần thật (qua `executeAiAction` + provider giả) ở `test/integration/mode1/metered-ai.int.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const calls: string[] = []

vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: vi.fn() }))
vi.mock("../pipeline/meter.service.js", () => ({
  reserveCall: vi.fn(async (_p: string, _u: string, stepId: string) => {
    calls.push(`reserve:${stepId}`)
    return `usage-${calls.length}`
  }),
  finalizeCall: vi.fn(async (usageId: string) => {
    calls.push(`finalize:${usageId}`)
  }),
  releaseCall: vi.fn(async (usageId: string) => {
    calls.push(`release:${usageId}`)
  })
}))

import { executeAiAction } from "../../shared/ai/ai-action.service.js"
import { AiActionError, ActionType } from "../../shared/ai/ai-action.types.js"
import { finalizeCall, releaseCall, reserveCall } from "../pipeline/meter.service.js"
import { isInsufficientCredit, withMeteredAi } from "./metered-ai.js"

const exec = vi.mocked(executeAiAction)
const PROJECT = "64b000000000000000000001"
const USER = "64b000000000000000000002"

const aiOk = (data: unknown, tokens = { promptTokens: 120, completionTokens: 30 }, cost = 3, logId = "log-1") =>
  ({
    success: true,
    data,
    rawText: JSON.stringify(data),
    actionType: ActionType.CR_CLARIFY,
    provider: "mock",
    aiModel: "mock",
    tokensUsed: { ...tokens, totalTokens: tokens.promptTokens + tokens.completionTokens },
    latencyMs: 1,
    logId,
    cost
  }) as Awaited<ReturnType<typeof executeAiAction>>

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
})

describe("withMeteredAi — từng loại gọi", () => {
  it.each([
    ["I-4:fixed:4.2.3", ActionType.IMPORT_EXTRACT_FIELDS],
    ["I-1.11", ActionType.IMPORT_SEMANTIC_CHECK],
    ["C-2:CR-001", ActionType.CR_CLARIFY],
    ["C-4:CR-001", ActionType.CR_PROPOSE],
    ["C-5:CR-012", ActionType.CR_CONSISTENCY]
  ])("step %s (%s): reserve đúng step_id + call_kind → gọi AI một lần → finalize số liệu thật", async (stepId, action) => {
    exec.mockResolvedValueOnce(aiOk({ ok: 1 }))
    const res = await withMeteredAi<{ ok: number }>({ projectId: PROJECT, userId: USER, stepId }, action, { cr_description: "x" })

    expect(res).toEqual({ ok: true, data: { ok: 1 }, usageId: "usage-1", tokens_in: 120, tokens_out: 30, cost: 3 })
    expect(reserveCall).toHaveBeenCalledWith(PROJECT, USER, stepId, action)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(action, { promptVariables: { cr_description: "x" } }, PROJECT, USER, {})
    expect(finalizeCall).toHaveBeenCalledWith("usage-1", { call_kind: action, attempt: 1, tokens_in: 120, tokens_out: 30, cost: 3, logId: "log-1" })
    expect(releaseCall).not.toHaveBeenCalled()
    expect(calls).toEqual([`reserve:${stepId}`, "finalize:usage-1"])
  })

  it("phase 5: ảnh kèm theo đi thẳng xuống executeAiAction (IMPORT_EXTRACT_DIAGRAM)", async () => {
    exec.mockResolvedValueOnce(aiOk({ ok: 1 }))
    const images = [{ mime: "image/png" as const, data: "iVBORw0K" }]
    await withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "I-4:fixed:2.2.1" }, ActionType.IMPORT_EXTRACT_DIAGRAM, { block_id: "B0002" }, { images })
    expect(exec).toHaveBeenCalledWith(ActionType.IMPORT_EXTRACT_DIAGRAM, { promptVariables: { block_id: "B0002" } }, PROJECT, USER, { images })
  })

  it("logId rỗng ⇒ finalize ghi logId null", async () => {
    exec.mockResolvedValueOnce(aiOk({}, { promptTokens: 1, completionTokens: 2 }, 0, ""))
    await withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "C-2:CR-001" }, ActionType.CR_CLARIFY, {})
    expect(vi.mocked(finalizeCall).mock.calls[0][1]).toMatchObject({ logId: null, cost: 0 })
  })
})

describe("withMeteredAi — lỗi", () => {
  it("hết credit (INSUFFICIENT_CREDIT) ⇒ release usage, reason credits, không ném lỗi", async () => {
    exec.mockRejectedValueOnce(new AiActionError(402, "Không đủ credit", "INSUFFICIENT_CREDIT"))
    const res = await withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "C-4:CR-002" }, ActionType.CR_PROPOSE, {})
    expect(res).toEqual({ ok: false, reason: "credits", message: "Không đủ credit", usageId: "usage-1" })
    expect(calls).toEqual(["reserve:C-4:CR-002", "release:usage-1"])
    expect(finalizeCall).not.toHaveBeenCalled()
  })

  it("402 với code khác vẫn tính là hết credit", async () => {
    exec.mockRejectedValueOnce(new AiActionError(402, "Payment required", "PAYMENT_REQUIRED"))
    const res = await withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "I-1.11" }, ActionType.IMPORT_SEMANTIC_CHECK, {})
    expect(res).toMatchObject({ ok: false, reason: "credits" })
  })

  it("lỗi provider còn lại sau retry (đã retry trong executeAiAction) ⇒ release, reason resume_later; không tự gọi lại lần nữa", async () => {
    exec.mockRejectedValueOnce(new AiActionError(500, "Provider down", "AI_EXECUTION_FAILED"))
    const res = await withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "I-4:fixed:1" }, ActionType.IMPORT_EXTRACT_FIELDS, {})
    expect(res).toEqual({ ok: false, reason: "resume_later", message: "Provider down", usageId: "usage-1" })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(["reserve:I-4:fixed:1", "release:usage-1"])
  })

  it("lỗi không phải Error (chuỗi) ⇒ message là chuỗi đó, resume_later", async () => {
    exec.mockRejectedValueOnce("timeout thô")
    const res = await withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "C-5:CR-001" }, ActionType.CR_CONSISTENCY, {})
    expect(res).toMatchObject({ ok: false, reason: "resume_later", message: "timeout thô" })
  })

  it("finalize lỗi (ghi sổ usage hỏng) ⇒ đi nhánh lỗi: release + resume_later", async () => {
    exec.mockResolvedValueOnce(aiOk({ ok: 1 }))
    vi.mocked(finalizeCall).mockRejectedValueOnce(new Error("write conflict"))
    const res = await withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "C-2:CR-001" }, ActionType.CR_CLARIFY, {})
    expect(res).toMatchObject({ ok: false, reason: "resume_later", message: "write conflict" })
    expect(releaseCall).toHaveBeenCalledWith("usage-1")
  })

  it("reserve lỗi ⇒ ném ra ngoài, không gọi AI", async () => {
    vi.mocked(reserveCall).mockRejectedValueOnce(new Error("Mongo down"))
    await expect(withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "C-2:CR-001" }, ActionType.CR_CLARIFY, {})).rejects.toThrow("Mongo down")
    expect(exec).not.toHaveBeenCalled()
  })
})

describe("isInsufficientCredit", () => {
  it("chỉ nhận AiActionError có code INSUFFICIENT_CREDIT hoặc status 402", () => {
    expect(isInsufficientCredit(new AiActionError(402, "x", "ANY"))).toBe(true)
    expect(isInsufficientCredit(new AiActionError(400, "x", "INSUFFICIENT_CREDIT"))).toBe(true)
    expect(isInsufficientCredit(new AiActionError(429, "x", "RATE_LIMIT_EXCEEDED"))).toBe(false)
    expect(isInsufficientCredit(Object.assign(new Error("x"), { code: "INSUFFICIENT_CREDIT", statusCode: 402 }))).toBe(false)
    expect(isInsufficientCredit(null)).toBe(false)
  })
})
