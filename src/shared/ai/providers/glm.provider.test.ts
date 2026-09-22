import { describe, it, expect, vi, beforeEach } from "vitest"

const create = vi.hoisted(() => vi.fn())
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } }
  }
}))

import { callGLM, stripReasoning, GLM_REASONING_HEADROOM_TOKENS } from "./glm.provider.js"

const streamOf = (...parts: string[]) =>
  (async function* () {
    for (const content of parts) yield { choices: [{ delta: { content } }] }
    yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }
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

    // Tham số thứ hai là request options của SDK (chỗ truyền `signal` khi huỷ lượt — FLF-177 WP-4)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: "low", response_format: { type: "json_object" }, stream: true }),
      undefined
    )
    expect(create.mock.calls[0][0]).not.toHaveProperty("thinking")
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 100 + GLM_REASONING_HEADROOM_TOKENS })
    expect(JSON.parse(res.text)).toEqual({ reply: "hi", questions: [] })
    expect(res).toMatchObject({ promptTokens: 10, completionTokens: 20 })
  })

  it("truyền AbortSignal xuống SDK để huỷ lượt là huỷ luôn request tới model", async () => {
    const controller = new AbortController()
    create.mockResolvedValue(streamOf('{"reply":"hi","questions":[]}'))
    await callGLM("prompt", { provider: "glm", model: "zai-org/GLM-5.3-Flash", maxTokens: 100 } as never, controller.signal)
    expect(create).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal })
  })

  it("content rỗng (hết token cho phần suy nghĩ) ⇒ GLM_EMPTY_OUTPUT kèm finish_reason", async () => {
    create.mockResolvedValue(
      (async function* () {
        yield { choices: [{ delta: { reasoning_content: "thinking..." } }] }
        yield { choices: [{ delta: {}, finish_reason: "length" }] }
      })()
    )

    await expect(callGLM("prompt", { provider: "glm", maxTokens: 100 } as never)).rejects.toMatchObject({
      code: "GLM_EMPTY_OUTPUT",
      message: expect.stringContaining("finish_reason=length")
    })
  })
})
