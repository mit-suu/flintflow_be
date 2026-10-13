import { describe, it, expect, vi, beforeEach } from "vitest"

const post = vi.hoisted(() => vi.fn())
const env = vi.hoisted(() => ({
  GEMINI_API_KEY: "test-key",
  AI_PROVIDER_OVERRIDE: "",
  EMBEDDING_PROVIDER: "gemini",
  EMBEDDING_MODEL: "gemini-embedding-001",
  EMBEDDING_DIMENSIONS: 4,
  EMBEDDING_API_BASE_URL: "https://embed.test/v1beta",
  EMBEDDING_TIMEOUT_MS: 1000
}))
vi.mock("axios", () => ({ default: { post } }))
vi.mock("../../../config/env.js", () => ({ env }))
vi.mock("../retry.service.js", async (orig) => ({ ...(await orig<typeof import("../retry.service.js")>()), delay: vi.fn(async () => undefined) }))

import { EMBED_BATCH_SIZE, embedTexts, embeddingAvailable, embeddingModelId, embeddingProvider } from "./embedding.provider.js"
import { mockEmbedding } from "./embedding.mock.js"

const ok = (n: number) => ({ data: { embeddings: Array.from({ length: n }, () => ({ values: [3, 0, 4, 0] })) } })
const httpError = (status: number) => Object.assign(new Error(`status ${status}`), { response: { status, data: { error: { message: `HTTP ${status}` } } } })

beforeEach(() => {
  post.mockReset()
  Object.assign(env, { GEMINI_API_KEY: "test-key", AI_PROVIDER_OVERRIDE: "", EMBEDDING_PROVIDER: "gemini" })
})

describe("embeddingProvider — chọn provider như callLLM", () => {
  it("off ⇒ null kể cả khi override mock; gemini thiếu key ⇒ null; override mock ⇒ mock", () => {
    env.EMBEDDING_PROVIDER = "off"
    env.AI_PROVIDER_OVERRIDE = "mock"
    expect(embeddingProvider()).toBeNull()
    expect(embeddingAvailable()).toBe(false)
    env.EMBEDDING_PROVIDER = "gemini"
    expect(embeddingProvider()).toBe("mock")
    expect(embeddingModelId()).toBe("mock-bow-4")
    env.AI_PROVIDER_OVERRIDE = ""
    expect(embeddingProvider()).toBe("gemini")
    expect(embeddingModelId()).toBe("gemini-embedding-001@4")
    env.GEMINI_API_KEY = ""
    expect(embeddingProvider()).toBeNull()
  })
})

describe("embedTexts — Gemini", () => {
  it("chia lô 100, giữ thứ tự, gửi taskType + outputDimensionality, key qua header; vector chuẩn hoá L2", async () => {
    post.mockImplementation(async (_url: string, body: { requests: unknown[] }) => ok(body.requests.length))
    const texts = Array.from({ length: EMBED_BATCH_SIZE + 5 }, (_, i) => `t${i}`)
    const out = await embedTexts(texts, { taskType: "RETRIEVAL_DOCUMENT" })
    expect(out).toHaveLength(105)
    expect(out[0]).toEqual([0.6, 0, 0.8, 0])
    expect(post).toHaveBeenCalledTimes(2)
    const [url, body, config] = post.mock.calls[0]
    expect(url).toBe("https://embed.test/v1beta/models/gemini-embedding-001:batchEmbedContents")
    expect(url).not.toContain("key=")
    expect(config.headers["x-goog-api-key"]).toBe("test-key")
    expect(body.requests[0]).toEqual({ model: "models/gemini-embedding-001", content: { parts: [{ text: "t0" }] }, taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 4 })
    expect(post.mock.calls[1][1].requests).toHaveLength(5)
  })

  it("503 ⇒ gọi lại; 400 ⇒ ném ngay; sai số chiều ⇒ EMBEDDING_BAD_RESPONSE", async () => {
    post.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(ok(1))
    await expect(embedTexts(["a"], { taskType: "RETRIEVAL_QUERY" })).resolves.toHaveLength(1)
    expect(post).toHaveBeenCalledTimes(2)

    post.mockReset().mockRejectedValue(httpError(400))
    await expect(embedTexts(["a"], { taskType: "RETRIEVAL_QUERY" })).rejects.toMatchObject({ statusCode: 400, code: "EMBEDDING_ERROR" })
    expect(post).toHaveBeenCalledTimes(1)

    post.mockReset().mockResolvedValue({ data: { embeddings: [{ values: [1, 2] }] } })
    await expect(embedTexts(["a"], { taskType: "RETRIEVAL_QUERY" })).rejects.toMatchObject({ code: "EMBEDDING_BAD_RESPONSE" })
  })

  it("waitOnRateLimit: 429 theo phút ⇒ chờ đúng thời gian Google báo rồi gọi lại; quota ngày (chờ quá lâu) ⇒ ném ngay", async () => {
    const { delay } = await import("../retry.service.js")
    vi.mocked(delay).mockClear()
    const perMinute = Object.assign(new Error("429"), {
      response: { status: 429, data: { error: { message: "You exceeded your current quota… Please retry in 25.59s.", details: [{ retryDelay: "25s" }] } } }
    })
    post.mockRejectedValueOnce(perMinute).mockRejectedValueOnce(perMinute).mockResolvedValueOnce(ok(1))
    await expect(embedTexts(["a"], { taskType: "RETRIEVAL_DOCUMENT", waitOnRateLimit: true })).resolves.toHaveLength(1)
    expect(post).toHaveBeenCalledTimes(3)
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([25_500, 25_500])

    const perDay = Object.assign(new Error("429"), { response: { status: 429, data: { error: { message: "Quota exceeded. Please retry in 3600s." } } } })
    post.mockReset().mockRejectedValue(perDay)
    await expect(embedTexts(["a"], { taskType: "RETRIEVAL_DOCUMENT", waitOnRateLimit: true })).rejects.toMatchObject({ code: "RATE_LIMIT_EXCEEDED", details: { retryAfterMs: 3_600_000 } })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("429 không kèm thời gian chờ: waitOnRateLimit ⇒ chờ mặc định 60 s; mặc định (request người dùng) ⇒ hỏng ngay, không chờ", async () => {
    const { delay } = await import("../retry.service.js")
    vi.mocked(delay).mockClear()
    const noHint = Object.assign(new Error("429"), { response: { status: 429, data: { error: { message: "You exceeded your current quota, please check your plan and billing details." } } } })
    post.mockRejectedValueOnce(noHint).mockResolvedValueOnce(ok(1))
    await expect(embedTexts(["a"], { taskType: "RETRIEVAL_DOCUMENT", waitOnRateLimit: true })).resolves.toHaveLength(1)
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([60_500])

    vi.mocked(delay).mockClear()
    post.mockReset().mockRejectedValue(noHint)
    await expect(embedTexts(["a"], { taskType: "RETRIEVAL_QUERY" })).rejects.toMatchObject({ code: "RATE_LIMIT_EXCEEDED" })
    expect(post).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })

  it("retryAfterMs đọc RetryInfo trước, rồi câu lỗi; không có ⇒ null", async () => {
    const { retryAfterMs } = await import("./embedding.provider.js")
    expect(retryAfterMs({ error: { details: [{ "@type": "x" }, { retryDelay: "12s" }] } }, "Please retry in 40s")).toBe(12_000)
    expect(retryAfterMs(undefined, "Please retry in 25.592450374s.")).toBe(25_593)
    expect(retryAfterMs(undefined, "rate limited")).toBeNull()
  })

  it("timeout ⇒ EMBEDDING_TIMEOUT sau khi hết lượt gọi lại", async () => {
    post.mockRejectedValue(Object.assign(new Error("timeout of 1000ms exceeded"), { code: "ECONNABORTED" }))
    await expect(embedTexts(["a"], { taskType: "RETRIEVAL_QUERY" })).rejects.toMatchObject({ code: "EMBEDDING_TIMEOUT" })
    expect(post).toHaveBeenCalledTimes(3)
  })

  it("chia lô theo cả số text lẫn ký tự (trần token/phút của free tier), giữ thứ tự", async () => {
    const { embedBatches, EMBED_BATCH_MAX_CHARS } = await import("./embedding.provider.js")
    const big = "x".repeat(2_000)
    const batches = embedBatches(Array.from({ length: 100 }, () => big))
    expect(batches.every((b) => b.join("").length <= EMBED_BATCH_MAX_CHARS)).toBe(true)
    expect(batches.map((b) => b.length)).toEqual([30, 30, 30, 10])
    expect(embedBatches(["a", "b", "c"], 2, 100)).toEqual([["a", "b"], ["c"]])
    // một text dài hơn trần vẫn đi một mình, không bị bỏ
    expect(embedBatches(["y".repeat(70_000), "z"])).toEqual([["y".repeat(70_000)], ["z"]])
  })

  it("không dùng được ⇒ EMBEDDING_UNAVAILABLE, không gọi mạng", async () => {
    env.EMBEDDING_PROVIDER = "off"
    await expect(embedTexts(["a"], { taskType: "RETRIEVAL_QUERY" })).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" })
    expect(post).not.toHaveBeenCalled()
  })
})

describe("embedding giả", () => {
  it("tất định, đơn vị; câu chung từ gần nhau hơn câu không chung từ", async () => {
    env.EMBEDDING_PROVIDER = "mock"
    const [a, b, c] = await embedTexts(["session timeout logout", "Session timeout after idle", "export invoice pdf"], { taskType: "RETRIEVAL_DOCUMENT" })
    expect(post).not.toHaveBeenCalled()
    expect(a).toEqual(mockEmbedding("session timeout logout", 4))
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0)
    expect(dot(a!, a!)).toBeCloseTo(1)
    const big = (t: string) => mockEmbedding(t, 256)
    expect(dot(big("session timeout logout"), big("session timeout after idle"))).toBeGreaterThan(dot(big("session timeout logout"), big("export invoice pdf")))
  })
})
