import { describe, it, expect } from "vitest"
import { definitionDrift, vectorIndexDefinition, VECTOR_FILTER_FIELDS } from "./migrate-spine-embeddings.js"

describe("migrate-spine-embeddings", () => {
  it("định nghĩa index khớp index dev: vector `embedding` cosine + 4 field lọc", () => {
    expect(vectorIndexDefinition(768)).toEqual({
      fields: [
        { type: "vector", path: "embedding", numDimensions: 768, similarity: "cosine" },
        { type: "filter", path: "projectId" },
        { type: "filter", path: "kind" },
        { type: "filter", path: "entity" },
        { type: "filter", path: "spine_version" }
      ]
    })
    expect(VECTOR_FILTER_FIELDS).toContain("projectId")
  })

  it("index có sẵn: khớp ⇒ null; lệch số chiều / thiếu field lọc ⇒ báo", () => {
    const name = "spine_embeddings_vector"
    expect(definitionDrift({ name, latestDefinition: vectorIndexDefinition(768) }, 768)).toBeNull()
    expect(definitionDrift({ name, latestDefinition: vectorIndexDefinition(768) }, 1536)).toContain("768")
    const noFilter = { fields: [{ type: "vector", path: "embedding", numDimensions: 768 }, { type: "filter", path: "projectId" }] }
    expect(definitionDrift({ name, latestDefinition: noFilter }, 768)).toBe("thiếu field lọc kind, entity, spine_version")
    expect(definitionDrift({ name }, 768)).toContain("embedding")
  })
})
