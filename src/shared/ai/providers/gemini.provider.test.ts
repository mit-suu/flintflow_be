import { describe, it, expect, vi, beforeEach } from "vitest"

const post = vi.hoisted(() => vi.fn())
vi.mock("axios", () => ({ default: { post } }))
vi.mock("../../../config/env.js", () => ({ env: { GEMINI_API_KEY: "test-key", AI_PROVIDER_OVERRIDE: "" } }))

import { AiActionError } from "../ai-action.types.js"
import { callGemini } from "./gemini.provider.js"
import { callLLM } from "./llm.router.js"

const ok = { data: { candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 } } }

beforeEach(() => post.mockReset().mockResolvedValue(ok))

describe("callGemini — ảnh (mode 1 v3 phase 5)", () => {
  it("ảnh đi sau chữ dạng inline_data base64; không ảnh ⇒ chỉ một part chữ", async () => {
    await callGemini("Read this", { provider: "gemini", model: "gemini-3.5-flash" }, { images: [{ mime: "image/png", data: "iVBORw0K" }] })
    expect(post.mock.calls[0][1].contents).toEqual([{ parts: [{ text: "Read this" }, { inline_data: { mime_type: "image/png", data: "iVBORw0K" } }] }])
    await callGemini("Only text", { provider: "gemini", model: "" })
    expect(post.mock.calls[1][1].contents).toEqual([{ parts: [{ text: "Only text" }] }])
  })
})

describe("callLLM — ảnh chỉ cho provider có vision", () => {
  it("gửi ảnh cho glm ⇒ AI_PROVIDER_NO_VISION (không gọi mạng); gemini ⇒ đi qua", async () => {
    await expect(callLLM("x", { provider: "glm", model: "" }, { images: [{ mime: "image/jpeg", data: "/9j/" }] })).rejects.toMatchObject({ code: "AI_PROVIDER_NO_VISION" })
    expect(post).not.toHaveBeenCalled()
    await expect(callLLM("x", { provider: "gemini", model: "" }, { images: [{ mime: "image/jpeg", data: "/9j/" }] })).resolves.toMatchObject({ promptTokens: 300 })
  })
})

/** Lỗi axios có response như Gemini trả (503 "high demand", 400…). */
const httpError = (status: number, message: string) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { code: status, message, status: "X" } } } })
const HIGH_DEMAND = "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later."
const modelOf = (call: unknown[]) => /models\/([^:]+):/.exec(String(call[0]))?.[1]
const cfg = { provider: "gemini", model: "gemini-3.5-flash", fallbackModels: ["gemini-3.6-flash", "gemini-3.5-flash-lite"] }

describe("callGemini — model dự phòng khi quá tải", () => {
  it("model chính 503 ⇒ chuyển model dự phòng đầu tiên; trả `model` đã trả lời", async () => {
    post.mockRejectedValueOnce(httpError(503, HIGH_DEMAND)).mockResolvedValueOnce(ok)
    await expect(callGemini("x", cfg)).resolves.toMatchObject({ model: "gemini-3.6-flash", promptTokens: 300 })
    expect(post.mock.calls.map(modelOf)).toEqual(["gemini-3.5-flash", "gemini-3.6-flash"])
  })

  it("429 hạn mức theo model / timeout ⇒ cũng chuyển; model chính trả lời ⇒ không gọi model dự phòng", async () => {
    post.mockRejectedValueOnce(httpError(429, "Resource has been exhausted (e.g. check quota).")).mockRejectedValueOnce(Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ECONNABORTED" })).mockResolvedValueOnce(ok)
    await expect(callGemini("x", cfg)).resolves.toMatchObject({ model: "gemini-3.5-flash-lite" })
    post.mockReset().mockResolvedValue(ok)
    await expect(callGemini("x", cfg)).resolves.toMatchObject({ model: "gemini-3.5-flash" })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("mọi model quá tải ⇒ ném GEMINI_OVERLOADED kèm danh sách model đã thử", async () => {
    for (let i = 0; i < 3; i++) post.mockRejectedValueOnce(httpError(503, HIGH_DEMAND))
    const err = (await callGemini("x", cfg).catch((e: unknown) => e)) as AiActionError
    expect(err instanceof AiActionError).toBe(true)
    expect([err.statusCode, err.code]).toEqual([503, "GEMINI_OVERLOADED"])
    expect(err.message).toContain("đã thử gemini-3.5-flash, gemini-3.6-flash, gemini-3.5-flash-lite")
    expect(post).toHaveBeenCalledTimes(3)
  })

  it("lỗi không phải quá tải (400 / hết tiền) ⇒ ném ngay, không thử model khác", async () => {
    post.mockRejectedValueOnce(httpError(400, "Invalid argument"))
    await expect(callGemini("x", cfg)).rejects.toMatchObject({ statusCode: 400 })
    post.mockReset().mockRejectedValueOnce(httpError(429, "You exceeded your current quota, please check your plan and billing details."))
    await expect(callGemini("x", cfg)).rejects.toMatchObject({ statusCode: 429 })
    expect(post).toHaveBeenCalledTimes(1)
  })
})
