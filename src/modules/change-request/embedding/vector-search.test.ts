import { describe, it, expect, vi, beforeEach } from "vitest"
import mongoose from "mongoose"

const aggregate = vi.hoisted(() => vi.fn())
const embed = vi.hoisted(() => ({ available: true, embedTexts: vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0, 0, 0])) }))
vi.mock("../../../config/env.js", () => ({ env: { EMBEDDING_DIMENSIONS: 4, CR_VECTOR_TOP_K: 5, CR_VECTOR_MIN_SCORE: 0.8 } }))
vi.mock("../../../shared/ai/embedding/embedding.provider.js", () => ({ embeddingAvailable: () => embed.available, embedTexts: embed.embedTexts }))
vi.mock("./spine-embedding.model.js", () => ({
  SPINE_EMBEDDING_INDEX: "spine_embeddings_vector",
  SpineEmbedding: { aggregate: (pipeline: unknown[]) => ({ exec: () => aggregate(pipeline) }) }
}))

import { isVectorSearchSupported, isVectorSearchUnsupported, resetVectorSearchSupport, vectorCandidates } from "./vector-search.js"

const PID = new mongoose.Types.ObjectId().toHexString()
const unsupported = Object.assign(new Error("$vectorSearch is not allowed or the syntax is incorrect, see the Atlas documentation for more information"), { code: 6047401 })

beforeEach(() => {
  aggregate.mockReset()
  embed.embedTexts.mockClear()
  embed.available = true
  resetVectorSearchSupport()
})

describe("isVectorSearchUnsupported", () => {
  it("nhận lỗi stage lạ / chỉ có trên Atlas / search chưa bật; lỗi khác thì không", () => {
    expect(isVectorSearchUnsupported(unsupported)).toBe(true)
    expect(isVectorSearchUnsupported({ code: 40324, message: "Unrecognized pipeline stage name: '$vectorSearch'" })).toBe(true)
    expect(isVectorSearchUnsupported({ codeName: "SearchNotEnabled", message: "x" })).toBe(true)
    expect(isVectorSearchUnsupported(new Error("connection reset"))).toBe(false)
    expect(isVectorSearchUnsupported({ code: 2, message: "$vectorSearch.queryVector must have 768 dims" })).toBe(false)
    expect(isVectorSearchUnsupported(null)).toBe(false)
  })
})

describe("vectorCandidates", () => {
  it("Mongo không có $vectorSearch ⇒ [] và nhớ: lần sau không thăm dò, không embed query", async () => {
    aggregate.mockRejectedValue(unsupported)
    expect(await vectorCandidates(PID, "session timeout")).toEqual([])
    expect(await vectorCandidates(PID, "session timeout")).toEqual([])
    expect(aggregate).toHaveBeenCalledTimes(1)
    expect(embed.embedTexts).not.toHaveBeenCalled()
    expect(await isVectorSearchSupported()).toBe(false)
  })

  it("embedding tắt ⇒ [] không đụng DB; query rỗng ⇒ []", async () => {
    embed.available = false
    expect(await vectorCandidates(PID, "x")).toEqual([])
    embed.available = true
    expect(await vectorCandidates(PID, "   ")).toEqual([])
    expect(aggregate).not.toHaveBeenCalled()
  })

  it("Atlas ⇒ $vectorSearch lọc projectId + kind, lọc điểm < ngưỡng, giảm dần", async () => {
    aggregate.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { ref: "nfrs[id=NFR-01]", score: 0.84 },
      { ref: "use_cases[id=UC-01]", score: 0.92 },
      { ref: "actors[id=A01]", score: 0.6 }
    ])
    expect(await vectorCandidates(PID, "tự đăng xuất")).toEqual([
      { ref: "use_cases[id=UC-01]", score: 0.92 },
      { ref: "nfrs[id=NFR-01]", score: 0.84 }
    ])
    expect(embed.embedTexts).toHaveBeenCalledWith(["tự đăng xuất"], { taskType: "RETRIEVAL_QUERY" })
    const [stage, project] = aggregate.mock.calls[1]![0] as [{ $vectorSearch: Record<string, unknown> }, unknown]
    expect(stage.$vectorSearch).toMatchObject({ index: "spine_embeddings_vector", path: "embedding", queryVector: [1, 0, 0, 0], limit: 5, numCandidates: 100 })
    expect(String((stage.$vectorSearch.filter as { projectId: unknown }).projectId)).toBe(PID)
    expect((stage.$vectorSearch.filter as { kind: string }).kind).toBe("element")
    expect(project).toEqual({ $project: { _id: 0, ref: 1, score: { $meta: "vectorSearchScore" } } })
    // limit / minScore truyền tay
    aggregate.mockResolvedValueOnce([{ ref: "actors[id=A01]", score: 0.6 }])
    expect(await vectorCandidates(PID, "x", { limit: 2, minScore: 0.5 })).toEqual([{ ref: "actors[id=A01]", score: 0.6 }])
  })

  it("lỗi tạm thời (thăm dò hoặc embed) ⇒ [] nhưng không nhớ — lần sau thử lại", async () => {
    aggregate.mockRejectedValueOnce(new Error("connection reset"))
    expect(await vectorCandidates(PID, "x")).toEqual([])
    aggregate.mockResolvedValue([])
    embed.embedTexts.mockRejectedValueOnce(new Error("503"))
    expect(await vectorCandidates(PID, "x")).toEqual([])
    expect(await vectorCandidates(PID, "x")).toEqual([])
    expect(embed.embedTexts).toHaveBeenCalledTimes(2)
  })
})
