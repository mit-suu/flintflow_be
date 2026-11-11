import { describe, it, expect, vi, beforeEach } from "vitest"

const post = vi.hoisted(() => vi.fn())
vi.mock("axios", () => ({ default: { post } }))
vi.mock("../../../config/env.js", () => ({ env: { ANTHROPIC_API_KEY: "test-key", AI_PROVIDER_OVERRIDE: "" } }))

import { callAnthropic, ANTHROPIC_THINKING_HEADROOM_TOKENS, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.provider.js"
import { callLLM } from "./llm.router.js"
import { env } from "../../../config/env.js"

const reply = (data: Record<string, unknown>) => ({ data: { usage: { input_tokens: 10, output_tokens: 20 }, ...data } })

describe("callAnthropic", () => {
  beforeEach(() => {
    post.mockReset()
  })

  it("bỏ khối thinking, ghép các khối text; không gửi temperature; cộng đệm suy nghĩ vào max_tokens", async () => {
    post.mockResolvedValue(
      reply({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"a":' }, { type: "text", text: "1}" }] })
    )
    const res = await callAnthropic("prompt", { provider: "anthropic", maxTokens: 100, temperature: 0.2 } as never)

    expect(res).toMatchObject({ text: '{"a":1}', promptTokens: 10, completionTokens: 20 })
    const body = post.mock.calls[0][1]
    expect(body).toMatchObject({ model: DEFAULT_ANTHROPIC_MODEL, max_tokens: 100 + ANTHROPIC_THINKING_HEADROOM_TOKENS, output_config: { effort: "low" } })
    expect(body).not.toHaveProperty("temperature")
    expect(body.messages).toEqual([{ role: "user", content: "prompt" }])
  })

  it("router gửi đủ ảnh PNG/JPEG dạng base64 trước prompt và chuyển tiếp signal", async () => {
    post.mockResolvedValue(reply({ stop_reason: "end_turn", content: [{ type: "text", text: '{"text":"Read"}' }] }))
    const signal = new AbortController().signal
    const result = await callLLM("Read images", { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL }, {
      signal,
      images: [{ mime: "image/png", data: "iVBORw0K" }, { mime: "image/jpeg", data: "/9j/" }]
    })

    expect(result).toMatchObject({ text: '{"text":"Read"}', promptTokens: 10, completionTokens: 20 })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages")
    expect(post.mock.calls[0][1].messages).toEqual([{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } },
      { type: "text", text: "Read images" }
    ] }])
    expect(post.mock.calls[0][2].signal).toBe(signal)
  })

  it("danh sách ảnh rỗng vẫn gửi prompt chữ như trước", async () => {
    post.mockResolvedValue(reply({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }))
    await callLLM("Only text", { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL }, { images: [] })
    expect(post.mock.calls[0][1].messages).toEqual([{ role: "user", content: "Only text" }])
  })

  it("thiếu key khi đọc ảnh ⇒ ANTHROPIC_KEY_MISSING và không gọi mạng", async () => {
    const originalKey = env.ANTHROPIC_API_KEY
    env.ANTHROPIC_API_KEY = ""
    try {
      await expect(callLLM("Read", { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL }, {
        images: [{ mime: "image/png", data: "iVBORw0K" }]
      })).rejects.toMatchObject({ code: "ANTHROPIC_KEY_MISSING" })
      expect(post).not.toHaveBeenCalled()
    } finally {
      env.ANTHROPIC_API_KEY = originalKey
    }
  })

  it("stop_reason=max_tokens ⇒ RESPONSE_TRUNCATED", async () => {
    post.mockResolvedValue(reply({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"a":' }] }))
    await expect(callAnthropic("prompt", { provider: "anthropic" } as never)).rejects.toMatchObject({ code: "RESPONSE_TRUNCATED" })
  })

  it("stop_reason=refusal ⇒ ANTHROPIC_REFUSAL", async () => {
    post.mockResolvedValue(reply({ stop_reason: "refusal", content: [] }))
    await expect(callAnthropic("prompt", { provider: "anthropic" } as never)).rejects.toMatchObject({ code: "ANTHROPIC_REFUSAL" })
  })

  it("429 ⇒ RATE_LIMIT_EXCEEDED", async () => {
    post.mockImplementation(async () => {
      throw Object.assign(new Error("Request failed"), { response: { status: 429, data: { error: { message: "slow down" } } } })
    })
    const error = await callAnthropic("prompt", { provider: "anthropic" } as never).catch((e) => e)
    expect(error.code).toBe("RATE_LIMIT_EXCEEDED")
    expect(error.message).toBe("slow down")
  })
})
