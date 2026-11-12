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
import { classifyAiFailure, isInsufficientCredit, VISION_UNAVAILABLE, withMeteredAi } from "./metered-ai.js"

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

describe("withMeteredAi - từng loại gọi", () => {
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

describe("withMeteredAi - lỗi", () => {
  it("hết credit (INSUFFICIENT_CREDIT) ⇒ release usage, reason credits, không ném lỗi", async () => {
    exec.mockRejectedValueOnce(new AiActionError(402, "Không đủ credit", "INSUFFICIENT_CREDIT"))
    const res = await withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "C-4:CR-002" }, ActionType.CR_PROPOSE, {})
    expect(res).toEqual({ ok: false, reason: "credits", message: "Không đủ credit", userMessage: "Không đủ credit", usageId: "usage-1", code: "INSUFFICIENT_CREDIT", kind: "credits" })
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
    // FLF-247: text thô của provider chỉ ở `message` (log); câu cho user ở `userMessage`
    expect(res).toEqual({
      ok: false,
      reason: "resume_later",
      message: "Provider down",
      userMessage: "Dịch vụ AI đang gặp sự cố. Vui lòng thử lại sau ít phút.",
      usageId: "usage-1",
      code: "AI_EXECUTION_FAILED",
      // FLF-360: lỗi 500 chung (không phải quá tải) ⇒ I-4 không đọc lại cả lô
      kind: "config"
    })
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

describe("FLF-360 classifyAiFailure - lỗi tạm thời / hết credit / cấu hình", () => {
  it("tạm thời: quá tải \"high demand\", 503, 429 không phải hết tiền, timeout, lỗi mạng", () => {
    expect(classifyAiFailure(new AiActionError(503, "high demand", "GEMINI_OVERLOADED"))).toBe("transient")
    expect(classifyAiFailure(new AiActionError(503, "Service Unavailable", "PROVIDER_ERROR"))).toBe("transient")
    expect(classifyAiFailure(new AiActionError(529, "Overloaded", "ANTHROPIC_ERROR"))).toBe("transient")
    expect(classifyAiFailure(new AiActionError(429, "Too many requests", "RATE_LIMIT_EXCEEDED"))).toBe("transient")
    expect(classifyAiFailure(new AiActionError(504, "deadline", "GEMINI_TIMEOUT"))).toBe("transient")
    expect(classifyAiFailure(Object.assign(new Error("socket"), { code: "ECONNRESET" }))).toBe("transient")
    expect(classifyAiFailure(new Error("Request timeout after 60000ms"))).toBe("transient")
    expect(classifyAiFailure(new TypeError("fetch failed"))).toBe("transient")
  })

  it("hết credit: INSUFFICIENT_CREDIT / 402; 429 vì hết hạn mức chi của nhà cung cấp không phải tạm thời", () => {
    expect(classifyAiFailure(new AiActionError(402, "Insufficient credits", "INSUFFICIENT_CREDIT"))).toBe("credits")
    expect(classifyAiFailure(new AiActionError(402, "x", "OTHER"))).toBe("credits")
    expect(classifyAiFailure(new AiActionError(500, "You exceeded your current quota", "PROVIDER_ERROR"))).toBe("config")
  })

  it("sai schema / lỗi 500 chung (đã thử lại trong lượt gọi) không phải quá tải ⇒ không đọc lại cả lô", () => {
    expect(classifyAiFailure(new AiActionError(500, "bad json", "PARSE_FAILED"))).toBe("config")
    expect(classifyAiFailure(new AiActionError(500, "schema", "SCHEMA_MISMATCH"))).toBe("config")
    expect(classifyAiFailure(new AiActionError(500, "Provider down", "AI_EXECUTION_FAILED"))).toBe("config")
  })

  it("cấu hình / không tự khỏi: thiếu khoá vision, provider không nhận ảnh, 400 / 403", () => {
    expect(VISION_UNAVAILABLE.has("ANTHROPIC_KEY_MISSING")).toBe(true)
    expect(classifyAiFailure(new AiActionError(500, "Anthropic API key is missing.", "ANTHROPIC_KEY_MISSING"))).toBe("config")
    expect(classifyAiFailure(new AiActionError(500, "Gemini API key is missing.", "GEMINI_KEY_MISSING"))).toBe("config")
    expect(classifyAiFailure(new AiActionError(400, "no vision", "AI_PROVIDER_NO_VISION"))).toBe("config")
    expect(classifyAiFailure(new AiActionError(400, "bad request", "PROVIDER_ERROR"))).toBe("config")
    expect(classifyAiFailure(new AiActionError(403, "forbidden", "FORBIDDEN"))).toBe("config")
    expect(classifyAiFailure("boom")).toBe("config")
  })

  it("withMeteredAi trả loại lỗi cùng kết quả", async () => {
    exec.mockRejectedValueOnce(new AiActionError(503, "high demand", "GEMINI_OVERLOADED"))
    const r = await withMeteredAi({ projectId: PROJECT, userId: USER, stepId: "I-4:fixed:2.2.1" }, ActionType.IMPORT_EXTRACT_DIAGRAM, {})
    expect(r).toMatchObject({ ok: false, reason: "resume_later", kind: "transient" })
  })
})
