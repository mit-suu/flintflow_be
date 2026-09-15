import { describe, it, expect, vi, afterEach } from "vitest"
import { glmFetch } from "./ai-sdk.provider.js"

afterEach(() => vi.unstubAllGlobals())

describe("glmFetch", () => {
  it("chèn reasoning_effort=low + json_object vào body JSON, giữ các field khác", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)

    await glmFetch("https://modal.example/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm", stream: true }) })

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({
      model: "glm",
      stream: true,
      reasoning_effort: "low",
      response_format: { type: "json_object" }
    })
  })

  it("body không phải JSON thì gửi nguyên", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)

    await glmFetch("https://modal.example/x", { method: "POST", body: "raw" })

    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe("raw")
  })
})
