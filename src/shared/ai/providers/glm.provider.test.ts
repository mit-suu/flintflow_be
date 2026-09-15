import { describe, it, expect, vi, beforeEach } from "vitest"

const create = vi.hoisted(() => vi.fn())
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } }
  }
}))

import { callGLM, stripReasoning } from "./glm.provider.js"

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
    create.mockReset()
  })

  it("gửi thinking.type=disabled và trả text đã bỏ phần suy nghĩ", async () => {
    create.mockResolvedValue(streamOf("thinking {x}...", "</think>", '{"reply":"hi","questions":[]}'))

    const res = await callGLM("prompt", { provider: "glm", model: "zai-org/GLM-5.3-Flash", maxTokens: 100, temperature: 0.2 } as never)

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ thinking: { type: "disabled" }, stream: true }))
    expect(JSON.parse(res.text)).toEqual({ reply: "hi", questions: [] })
    expect(res).toMatchObject({ promptTokens: 10, completionTokens: 20 })
  })
})
