import { describe, it, expect, vi, beforeEach } from "vitest"

const create = vi.hoisted(() => vi.fn())
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } }
  }
}))

import { callGLM, stripReasoning, GLM_MAX_TOKENS_CEILING, GLM_REASONING_HEADROOM_TOKENS } from "./glm.provider.js"

const streamOf = (...parts: string[]) =>
  (async function* () {
    for (const content of parts) yield { choices: [{ delta: { content } }] }
    yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }
  })()

/** Lượt gọi đốt hết ngân sách cho phần suy nghĩ, không kịp trả content. */
const outOfBudget = () =>
  (async function* () {
    yield { choices: [{ delta: { reasoning_content: "thinking..." } }] }
    yield { choices: [{ delta: {}, finish_reason: "length" }] }
  })()

describe("stripReasoning", () => {
  it("bỏ phần suy nghĩ tới </think> cuối cùng", () => {
    expect(stripReasoning('Let me analyze {"reply": string}...</think>{"reply":"ok","questions":[]}')).toBe('{"reply":"ok","questions":[]}')
  })

  it("không có </think> thì giữ nguyên", () => {
    expect(stripReasoning('{"reply":"ok"}')).toBe('{"reply":"ok"}')
  })
})

describe("callGLM", () => {
  beforeEach(() => {
    process.env.MODAL_API_KEY = "test-key"
    // Từ T24 `MODAL_BASE_URL` không còn default trong code, nên test phải tự cấu hình y như khoá API.
    // Không đặt ở đây thì test chỉ xanh trên máy có `.env` và đỏ ở CI — đúng lỗi đã xảy ra.
    process.env.MODAL_BASE_URL = "https://modal.test/v1"
    create.mockReset()
  })

  it("gửi reasoning_effort=low + json_object và trả text đã bỏ phần suy nghĩ", async () => {
    create.mockResolvedValue(streamOf("thinking {x}...", "</think>", '{"reply":"hi","questions":[]}'))

    const res = await callGLM("prompt", { provider: "glm", model: "zai-org/GLM-5.3-Flash", maxTokens: 100, temperature: 0.2 } as never)

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: "low", response_format: { type: "json_object" }, stream: true })
    )
    expect(create.mock.calls[0][0]).not.toHaveProperty("thinking")
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 100 + GLM_REASONING_HEADROOM_TOKENS })
    expect(JSON.parse(res.text)).toEqual({ reply: "hi", questions: [] })
    expect(res).toMatchObject({ promptTokens: 10, completionTokens: 20 })
  })

  it("hết ngân sách cho phần suy nghĩ (finish_reason=length) ⇒ gọi lại một lần với max_tokens gấp đôi", async () => {
    create.mockResolvedValueOnce(outOfBudget()).mockResolvedValueOnce(streamOf('{"reply":"hi"}'))

    const res = await callGLM("prompt", { provider: "glm", maxTokens: 100 } as never)

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0][0].max_tokens).toBe(100 + GLM_REASONING_HEADROOM_TOKENS)
    expect(create.mock.calls[1][0].max_tokens).toBe(2 * (100 + GLM_REASONING_HEADROOM_TOKENS))
    expect(JSON.parse(res.text)).toEqual({ reply: "hi" })
  })

  it("nới ngân sách vẫn rỗng ⇒ GLM_EMPTY_OUTPUT nói rõ cả hai mức đã thử, không gọi lần ba", async () => {
    create.mockResolvedValue(outOfBudget())

    await expect(callGLM("prompt", { provider: "glm", maxTokens: 100 } as never)).rejects.toMatchObject({
      code: "GLM_EMPTY_OUTPUT",
      message: expect.stringContaining(`đã thử ${100 + GLM_REASONING_HEADROOM_TOKENS} trước đó`)
    })
    expect(create).toHaveBeenCalledTimes(2)
  })

  it("đã kịch trần, hoặc dừng vì lý do khác length ⇒ không gọi lại", async () => {
    create.mockResolvedValue(outOfBudget())
    await expect(callGLM("prompt", { provider: "glm", maxTokens: GLM_MAX_TOKENS_CEILING } as never)).rejects.toMatchObject({ code: "GLM_EMPTY_OUTPUT" })
    expect(create).toHaveBeenCalledTimes(1)

    create.mockReset()
    create.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      })()
    )
    await expect(callGLM("prompt", { provider: "glm", maxTokens: 100 } as never)).rejects.toMatchObject({ code: "GLM_EMPTY_OUTPUT" })
    expect(create).toHaveBeenCalledTimes(1)
  })
})
