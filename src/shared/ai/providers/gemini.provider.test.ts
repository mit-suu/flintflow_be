import { describe, it, expect, vi, beforeEach } from "vitest"

const post = vi.hoisted(() => vi.fn())
vi.mock("axios", () => ({ default: { post } }))
vi.mock("../../../config/env.js", () => ({ env: { GEMINI_API_KEY: "test-key", AI_PROVIDER_OVERRIDE: "" } }))

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
