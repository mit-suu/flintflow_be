import { describe, it, expect } from "vitest"
import { KNOWLEDGE_CHUNK_COLLECTION, KNOWLEDGE_TEXT_INDEX, KNOWLEDGE_TEXT_INDEX_WEIGHTS, KnowledgeChunk } from "./knowledge-chunk.model.js"

describe("KnowledgeChunk model", () => {
  it("collection knowledge_chunks, chunk_id unique", () => {
    expect(KnowledgeChunk.collection.collectionName).toBe(KNOWLEDGE_CHUNK_COLLECTION)
    expect(KnowledgeChunk.schema.path("chunk_id").options.unique).toBe(true)
  })

  it("text index trên section + embed_text, section nặng hơn; index thường (corpus, status)", () => {
    const indexes = KnowledgeChunk.schema.indexes() as [Record<string, unknown>, Record<string, unknown> | undefined][]
    const text = indexes.find(([, opts]) => opts?.name === KNOWLEDGE_TEXT_INDEX)
    expect(text?.[0]).toEqual({ section: "text", embed_text: "text" })
    expect(text?.[1]).toMatchObject({ weights: KNOWLEDGE_TEXT_INDEX_WEIGHTS, default_language: "english" })
    expect(KNOWLEDGE_TEXT_INDEX_WEIGHTS.section).toBeGreaterThan(KNOWLEDGE_TEXT_INDEX_WEIGHTS.embed_text)
    expect(indexes.some(([key]) => JSON.stringify(key) === JSON.stringify({ corpus: 1, status: 1 }))).toBe(true)
  })

  it("status và source_kind chỉ nhận giá trị đã định", () => {
    expect(KnowledgeChunk.schema.path("status").options.enum).toEqual(["placeholder", "verified"])
    expect(KnowledgeChunk.schema.path("source_kind").options.enum).toEqual(["internal_skill", "standard"])
  })
})
