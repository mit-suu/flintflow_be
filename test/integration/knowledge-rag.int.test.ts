/**
 * FLF-267 Knowledge RAG trên Mongo in-memory thật: ingest (diff theo `text_hash`, xoá chunk mất, từ chối khi không có
 * embedding), truy hồi hybrid (`$text` thật + vector `memory` — Mongo in-memory không có `$vectorSearch` nên cấu hình
 * `atlas` phải tự lùi về `memory`), lọc metadata, small-to-big, và script migrate index (search index không hỗ trợ ⇒ báo
 * nhẹ nhàng). Embedding `mock` đặt ngay trong file (setup.ts ép `off`); không gọi provider thật.
 */
import { afterAll, beforeEach, describe, it, expect } from "vitest"
import mongoose from "mongoose"
import { env } from "../../src/config/env.js"
import { chunkCorpus, chunkDocument, estimateTokens, type KnowledgeDoc } from "../../src/modules/knowledge/chunker.js"
import { loadCorpus } from "../../src/modules/knowledge/corpus.js"
import { ingestChunks } from "../../src/modules/knowledge/ingest.js"
import { KNOWLEDGE_CHUNK_COLLECTION, KnowledgeChunk } from "../../src/modules/knowledge/knowledge-chunk.model.js"
import { retrieveKnowledge } from "../../src/modules/knowledge/retrieve.js"
import { invalidateMemoryIndex, resetAtlasSupport } from "../../src/modules/knowledge/vector-backend.js"
import { migrateKnowledgeIndex } from "../../src/scripts/migrate-knowledge-index.js"

const saved = { provider: env.EMBEDDING_PROVIDER, backend: env.KNOWLEDGE_VECTOR_BACKEND, minScore: env.KNOWLEDGE_MIN_SCORE }
const skillChunks = chunkCorpus(loadCorpus("assets/skills", { corpus: "skills" })).chunks

beforeEach(() => {
  env.EMBEDDING_PROVIDER = "mock"
  env.KNOWLEDGE_VECTOR_BACKEND = "atlas"
  env.KNOWLEDGE_MIN_SCORE = 0.2
  invalidateMemoryIndex()
  resetAtlasSupport()
})

afterAll(() => {
  env.EMBEDDING_PROVIDER = saved.provider
  env.KNOWLEDGE_VECTOR_BACKEND = saved.backend
  env.KNOWLEDGE_MIN_SCORE = saved.minScore
})

describe("ingest", () => {
  it("lần đầu embed mọi chunk; chạy lại không embed gì; đổi một chunk + bỏ một chunk ⇒ embed 1, xoá 1", async () => {
    const embedded: string[][] = []
    const embed = async (texts: string[]) => {
      embedded.push(texts)
      return texts.map(() => [1, 0, 0])
    }
    const first = await ingestChunks(skillChunks, { corpus: "skills", embed, modelId: "test-model" })
    expect(first).toMatchObject({ chunks: skillChunks.length, embedded: skillChunks.length, unchanged: 0, deleted: 0 })
    expect(await KnowledgeChunk.countDocuments({ corpus: "skills" })).toBe(skillChunks.length)

    const second = await ingestChunks(skillChunks, { corpus: "skills", embed, modelId: "test-model" })
    expect(second).toMatchObject({ embedded: 0, unchanged: skillChunks.length, deleted: 0 })
    expect(embedded).toHaveLength(1)

    const [changed, ...rest] = skillChunks
    const next = [{ ...changed!, text: `${changed!.text} extra`, embed_text: `${changed!.embed_text} extra` }, ...rest.slice(1)]
    const third = await ingestChunks(next, { corpus: "skills", embed, modelId: "test-model" })
    expect(third).toMatchObject({ embedded: 1, deleted: 1, unchanged: next.length - 1 })
    expect(embedded[1]).toEqual([next[0]!.embed_text])
    expect(await KnowledgeChunk.exists({ chunk_id: rest[0]!.chunk_id })).toBeNull()

    // Đổi model ⇒ mọi hash lệch ⇒ embed lại toàn bộ
    const fourth = await ingestChunks(next, { corpus: "skills", embed, modelId: "other-model" })
    expect(fourth.embedded).toBe(next.length)
  })

  it("không xoá chunk của corpus khác; chunk lạc corpus bị từ chối", async () => {
    const embed = async (texts: string[]) => texts.map(() => [1, 0])
    await ingestChunks(skillChunks.slice(0, 3), { corpus: "skills", embed, modelId: "m" })
    const other = skillChunks.slice(3, 4).map((c) => ({ ...c, corpus: "standards", chunk_id: `std:${c.chunk_id}` }))
    await ingestChunks(other, { corpus: "standards", embed, modelId: "m" })
    expect(await KnowledgeChunk.countDocuments({ corpus: "skills" })).toBe(3)
    await expect(ingestChunks(other, { corpus: "skills", embed, modelId: "m" })).rejects.toThrow(/thuộc corpus "standards"/)
  })

  it("embedding tắt ⇒ từ chối, không ghi gì", async () => {
    env.EMBEDDING_PROVIDER = "off"
    await expect(ingestChunks(skillChunks, { corpus: "skills" })).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" })
    expect(await KnowledgeChunk.countDocuments()).toBe(0)
  })
})

describe("retrieveKnowledge", () => {
  beforeEach(async () => {
    await ingestChunks(skillChunks, { corpus: "skills" })
  })

  it("cấu hình atlas trên Mongo không có $vectorSearch ⇒ lùi về memory; hybrid gộp vector + $text", async () => {
    const res = await retrieveKnowledge("How many model calls per step and how many regenerates per step?", { corpus: "skills" })
    expect(res.backend).toBe("memory")
    expect(res.chunks).toHaveLength(env.KNOWLEDGE_TOP_K)
    expect(res.chunks.map((c) => c.chunk_id)).toContain("gate-check#caps")
    const caps = res.chunks.find((c) => c.chunk_id === "gate-check#caps")!
    expect(caps).toMatchObject({ source: "gate-check", source_kind: "internal_skill", status: "verified", section: "Caps" })
    expect(caps.vector_score).toBeGreaterThan(0)
    expect(caps.lexical_rank).toBeGreaterThan(0)
    expect(res.top_vector_score).toBe(Math.max(...res.chunks.map((c) => c.vector_score ?? -1)))
    expect(res.abstain).toBe(false)
    // Điểm RRF giảm dần
    expect(res.chunks.map((c) => c.rrf)).toEqual([...res.chunks.map((c) => c.rrf)].sort((a, b) => b - a))
  })

  it("câu không dính gì tới corpus ⇒ cosine thấp ⇒ abstain", async () => {
    const res = await retrieveKnowledge("zyxwv qqqqq plugh", { corpus: "skills" })
    expect(res.abstain).toBe(true)
  })

  it("chunk placeholder bị lọc trừ khi includePlaceholder; appliesTo chỉ giữ chunk của step đó", async () => {
    await KnowledgeChunk.updateOne({ chunk_id: "gate-check#caps" }, { $set: { status: "placeholder" } })
    invalidateMemoryIndex()
    const q = "How many model calls per step and how many regenerates per step?"
    expect((await retrieveKnowledge(q, { corpus: "skills", topK: 10 })).chunks.map((c) => c.chunk_id)).not.toContain("gate-check#caps")
    expect((await retrieveKnowledge(q, { corpus: "skills", topK: 10, includePlaceholder: true })).chunks.map((c) => c.chunk_id)).toContain("gate-check#caps")

    const scoped = await retrieveKnowledge("use case naming rules", { corpus: "skills", appliesTo: "S-3.2", topK: 10 })
    expect(scoped.chunks.length).toBeGreaterThan(0)
    const allowed = new Set(skillChunks.filter((c) => c.applies_to.includes("S-3.2")).map((c) => c.chunk_id))
    expect(scoped.chunks.every((c) => allowed.has(c.chunk_id))).toBe(true)
  })

  it("embedding tắt ⇒ chỉ $text (lexical-only), không có điểm vector; không khớp gì ⇒ abstain", async () => {
    env.EMBEDDING_PROVIDER = "off"
    const res = await retrieveKnowledge("regenerates per step", { corpus: "skills" })
    expect(res.backend).toBe("lexical-only")
    expect(res.top_vector_score).toBeNull()
    expect(res.abstain).toBe(false)
    expect(res.chunks.every((c) => c.vector_score === undefined && c.lexical_rank !== undefined)).toBe(true)
    expect((await retrieveKnowledge("zyxwvqqq", { corpus: "skills" })).abstain).toBe(true)
  })

  it("mode lexical bỏ vector; mode vector bỏ $text", async () => {
    const lexical = await retrieveKnowledge("regenerates per step", { corpus: "skills", mode: "lexical" })
    expect(lexical.backend).toBe("lexical-only")
    const vector = await retrieveKnowledge("regenerates per step", { corpus: "skills", mode: "vector" })
    expect(vector.backend).toBe("memory")
    expect(vector.chunks.every((c) => c.lexical_rank === undefined)).toBe(true)
  })
})

describe("small-to-big", () => {
  it("section bị cắt mà cả section ≤ 900 token ⇒ context_text là cả section", async () => {
    const rule = (n: number) => `${n}. ${Array.from({ length: 95 }, (_, i) => `token${n}x${i}`).join(" ")}`
    const doc: KnowledgeDoc = {
      corpus: "demo",
      doc_id: "demo",
      source: "demo",
      source_kind: "internal_skill",
      topic: "action",
      description: "demo",
      status: "verified",
      applies_to: [],
      body: ["## Rules", rule(1), rule(2), rule(3)].join("\n")
    }
    const { chunks } = chunkDocument(doc)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(estimateTokens(chunks.map((c) => c.text).join("\n\n"))).toBeLessThanOrEqual(900)
    await ingestChunks(chunks, { corpus: "demo" })
    const res = await retrieveKnowledge("token3x5 token3x6", { corpus: "demo", topK: 1 })
    expect(res.chunks[0]!.chunk_id).toBe("demo#rules/3")
    expect(res.chunks[0]!.text).not.toContain("token1x0")
    expect(res.chunks[0]!.context_text).toContain("token1x0")
    expect(res.chunks[0]!.context_text).toContain("token3x94")
  })
})

describe("migrate-knowledge-index", () => {
  afterAll(async () => {
    // Trả lại collection + index cho file test khác của worker này
    await KnowledgeChunk.createCollection().catch(() => undefined)
    await KnowledgeChunk.createIndexes()
  })

  it("dry-run không ghi; chạy thật tạo collection + text index, vector index báo không hỗ trợ; chạy lại là idempotent", async () => {
    const db = mongoose.connection.db!
    await db.dropCollection(KNOWLEDGE_CHUNK_COLLECTION).catch(() => undefined)

    const dry = await migrateKnowledgeIndex(db, { dryRun: true, dimensions: 768 })
    expect(dry).toMatchObject({ collection: "would_create", text_index: "would_create", vector_index: "would_create" })
    expect((await db.listCollections({ name: KNOWLEDGE_CHUNK_COLLECTION }).toArray()).length).toBe(0)

    const run = await migrateKnowledgeIndex(db, { dryRun: false, dimensions: 768 })
    expect(run).toMatchObject({ collection: "created", text_index: "created", vector_index: "unsupported" })
    expect(run.messages.join("\n")).toMatch(/không có Atlas Search|không tạo được search index/)
    const indexes = await db.collection(KNOWLEDGE_CHUNK_COLLECTION).indexes()
    expect(indexes.find((i) => i.name === "knowledge_chunks_text")?.weights).toEqual({ section: 4, embed_text: 1 })

    const again = await migrateKnowledgeIndex(db, { dryRun: false, dimensions: 768 })
    expect(again).toMatchObject({ collection: "exists", text_index: "exists", vector_index: "unsupported" })
  })

  it("text index khác tên đã có ⇒ chỉ báo, không đụng", async () => {
    const db = mongoose.connection.db!
    await db.dropCollection(KNOWLEDGE_CHUNK_COLLECTION).catch(() => undefined)
    await db.createCollection(KNOWLEDGE_CHUNK_COLLECTION)
    await db.collection(KNOWLEDGE_CHUNK_COLLECTION).createIndex({ text: "text" }, { name: "legacy_text" })
    const res = await migrateKnowledgeIndex(db, { dryRun: false, dimensions: 768 })
    expect(res.text_index).toBe("blocked")
    expect((await db.collection(KNOWLEDGE_CHUNK_COLLECTION).indexes()).map((i) => i.name)).toContain("legacy_text")
    await db.dropCollection(KNOWLEDGE_CHUNK_COLLECTION)
  })
})
