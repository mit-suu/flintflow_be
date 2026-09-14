import { describe, it, expect, beforeEach, vi } from "vitest"
import mongoose from "mongoose"

vi.mock("./credit-reservation.service.js", () => ({
  reserveCredit: vi.fn(),
  deductCredit: vi.fn(),
  releaseCredit: vi.fn()
}))
vi.mock("./prompt-registry.service.js", () => ({
  getPromptTemplate: vi.fn(async () => ({
    template: "prompt {{x}}",
    providerConfig: { provider: "mock", model: "mock-model" }
  })),
  interpolatePrompt: vi.fn(() => "prompt")
}))
vi.mock("./providers/llm.router.js", () => ({ callLLM: vi.fn() }))
vi.mock("./providers/ai-sdk.provider.js", () => ({ getAiSdkModel: vi.fn(() => ({})) }))
vi.mock("ai", () => ({ streamText: vi.fn() }))
vi.mock("./response-parser.js", () => ({ parseResponse: vi.fn() }))
// Chạy đúng một lần: test hành vi credit, không test backoff của retry
vi.mock("./retry.service.js", () => ({
  executeWithInRequestRetry: (fn: (attempt: number) => Promise<unknown>) => fn(0)
}))
vi.mock("../../modules/admin/ai-action-log.model.js", () => ({
  AiActionLog: { create: vi.fn() }
}))

import { executeAiAction, executeAiActionStream } from "./ai-action.service.js"
import { reserveCredit, deductCredit, releaseCredit } from "./credit-reservation.service.js"
import { callLLM } from "./providers/llm.router.js"
import { parseResponse } from "./response-parser.js"
import { streamText } from "ai"
import { AiActionLog } from "../../modules/admin/ai-action-log.model.js"
import { AiActionError, ActionType } from "./ai-action.types.js"

const USER = "64b000000000000000000020"
const reservation = {
  reservationId: "64b0000000000000000000ff",
  userId: USER,
  actionType: ActionType.GENERATE_SECTION,
  cost: 5,
  expiresAt: new Date()
}

const parseFailure = () => new AiActionError(500, "JSON hỏng", "PARSE_FAILED")

const fakeStream = (chunks: string[]) =>
  ({
    textStream: (async function* () {
      for (const c of chunks) yield c
    })(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 20 })
  }) as any

describe("executeAiAction — thứ tự parse → deduct", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(mongoose, "startSession").mockRejectedValue(
      new Error("Transaction numbers are only allowed on a replica set member or mongos")
    )
    vi.mocked(reserveCredit).mockResolvedValue(reservation)
    vi.mocked(deductCredit).mockResolvedValue(undefined)
    vi.mocked(releaseCredit).mockResolvedValue(true)
    vi.mocked(callLLM).mockResolvedValue({ text: "{}", promptTokens: 1, completionTokens: 1 } as any)
    vi.mocked(AiActionLog.create).mockResolvedValue({ _id: "log-1" } as any)
  })

  it("parse lỗi: không deduct, có release", async () => {
    vi.mocked(parseResponse).mockImplementation(() => {
      throw parseFailure()
    })

    await expect(executeAiAction(ActionType.GENERATE_SECTION, {}, undefined, USER)).rejects.toMatchObject({
      code: "PARSE_FAILED"
    })

    expect(deductCredit).not.toHaveBeenCalled()
    expect(releaseCredit).toHaveBeenCalledTimes(1)
    expect(releaseCredit).toHaveBeenCalledWith(reservation)
  })

  it("parse ok: deduct một lần, không release", async () => {
    vi.mocked(parseResponse).mockReturnValue({ ok: true })

    const result = await executeAiAction(ActionType.GENERATE_SECTION, {}, undefined, USER)

    expect(result.data).toEqual({ ok: true })
    expect(result.cost).toBe(5)
    expect(deductCredit).toHaveBeenCalledTimes(1)
    expect(deductCredit).toHaveBeenCalledWith(reservation)
    expect(releaseCredit).not.toHaveBeenCalled()
  })

  it("đã deduct rồi mà bước sau lỗi (ghi log): KHÔNG release", async () => {
    vi.mocked(parseResponse).mockReturnValue({ ok: true })
    vi.mocked(AiActionLog.create)
      .mockRejectedValueOnce(new Error("log write failed"))
      .mockResolvedValue({ _id: "log-2" } as any)

    await expect(executeAiAction(ActionType.GENERATE_SECTION, {}, undefined, USER)).rejects.toThrow()

    expect(deductCredit).toHaveBeenCalledTimes(1)
    expect(releaseCredit).not.toHaveBeenCalled()
  })

  it("LLM lỗi: không deduct, có release", async () => {
    vi.mocked(callLLM).mockRejectedValue(new Error("provider down"))

    await expect(executeAiAction(ActionType.GENERATE_SECTION, {}, undefined, USER)).rejects.toThrow()

    expect(deductCredit).not.toHaveBeenCalled()
    expect(releaseCredit).toHaveBeenCalledTimes(1)
  })
})

describe("executeAiActionStream — thứ tự parse → deduct", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(mongoose, "startSession").mockRejectedValue(
      new Error("Transaction numbers are only allowed on a replica set member or mongos")
    )
    vi.mocked(reserveCredit).mockResolvedValue(reservation)
    vi.mocked(deductCredit).mockResolvedValue(undefined)
    vi.mocked(releaseCredit).mockResolvedValue(true)
    vi.mocked(AiActionLog.create).mockResolvedValue({ _id: "log-1" } as any)
    vi.mocked(streamText).mockImplementation(() => fakeStream(['{"reply":', '"xin chào"}']))
  })

  it("parse lỗi: không deduct, có release (trước đây deduct rồi mới parse)", async () => {
    vi.mocked(parseResponse).mockImplementation(() => {
      throw parseFailure()
    })

    await expect(executeAiActionStream(ActionType.CHAT, {}, undefined, USER)).rejects.toMatchObject({
      code: "PARSE_FAILED"
    })

    expect(deductCredit).not.toHaveBeenCalled()
    expect(releaseCredit).toHaveBeenCalledTimes(1)
  })

  it("parse ok: deduct một lần, không release, kể cả khi onFinish ném lỗi", async () => {
    vi.mocked(parseResponse).mockReturnValue({ reply: "xin chào" })

    await expect(
      executeAiActionStream(ActionType.CHAT, {}, undefined, USER, {
        onFinish: () => {
          throw new Error("client disconnected")
        }
      })
    ).rejects.toThrow()

    expect(deductCredit).toHaveBeenCalledTimes(1)
    expect(releaseCredit).not.toHaveBeenCalled()
  })

  it("parse ok: trả kết quả kèm cost", async () => {
    vi.mocked(parseResponse).mockReturnValue({ reply: "xin chào" })

    const result = await executeAiActionStream(ActionType.CHAT, {}, undefined, USER)

    expect(result.cost).toBe(5)
    expect(deductCredit).toHaveBeenCalledTimes(1)
    expect(releaseCredit).not.toHaveBeenCalled()
  })
})
