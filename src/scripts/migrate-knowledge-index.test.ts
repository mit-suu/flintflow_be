import { describe, it, expect } from "vitest"
import { textIndexDrift, VECTOR_FILTER_FIELDS, vectorDefinitionDrift, vectorIndexDefinition } from "./migrate-knowledge-index.js"

describe("migrate-knowledge-index — định nghĩa", () => {
  it("vector index: cosine trên `embedding`, số chiều theo env, lọc corpus/status/source_kind/applies_to", () => {
    expect(VECTOR_FILTER_FIELDS).toEqual(["corpus", "status", "source_kind", "applies_to"])
    expect(vectorIndexDefinition(768)).toEqual({
      fields: [
        { type: "vector", path: "embedding", numDimensions: 768, similarity: "cosine" },
        { type: "filter", path: "corpus" },
        { type: "filter", path: "status" },
        { type: "filter", path: "source_kind" },
        { type: "filter", path: "applies_to" }
      ]
    })
  })

  it("báo lệch vector index: thiếu field, lệch số chiều, lệch similarity, thiếu field lọc; khớp ⇒ null", () => {
    expect(vectorDefinitionDrift({ name: "x", latestDefinition: vectorIndexDefinition(768) }, 768)).toBeNull()
    expect(vectorDefinitionDrift({ name: "x" }, 768)).toMatch(/thiếu field vector/)
    expect(vectorDefinitionDrift({ name: "x", latestDefinition: vectorIndexDefinition(1536) }, 768)).toMatch(/1536 chiều/)
    const euclid = { fields: [{ type: "vector", path: "embedding", numDimensions: 768, similarity: "euclidean" }] }
    expect(vectorDefinitionDrift({ name: "x", latestDefinition: euclid }, 768)).toMatch(/similarity euclidean/)
    const noFilters = { fields: [{ type: "vector", path: "embedding", numDimensions: 768 }] }
    expect(vectorDefinitionDrift({ name: "x", latestDefinition: noFilters }, 768)).toMatch(/thiếu field lọc corpus, status, source_kind, applies_to/)
  })

  it("báo lệch text index: trọng số, ngôn ngữ; khớp ⇒ null", () => {
    expect(textIndexDrift({ key: { _fts: "text" }, weights: { section: 4, embed_text: 1 }, default_language: "english" })).toBeNull()
    expect(textIndexDrift({ key: { _fts: "text" }, weights: { embed_text: 1 } })).toMatch(/section: — ≠ 4/)
    expect(textIndexDrift({ key: { _fts: "text" }, weights: { section: 4, embed_text: 1 }, default_language: "none" })).toMatch(/default_language none/)
  })
})
