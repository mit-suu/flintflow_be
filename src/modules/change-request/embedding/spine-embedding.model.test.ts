import { describe, expect, it } from "vitest"
import mongoose from "mongoose"
import { SPINE_EMBEDDING_COLLECTION, SPINE_EMBEDDING_INDEX, SpineEmbedding } from "./spine-embedding.model.js"

describe("SpineEmbedding", () => {
  it("collection + tên index khớp Atlas Vector Search đã tạo; unique (projectId, kind, ref)", () => {
    expect(SpineEmbedding.collection.collectionName).toBe(SPINE_EMBEDDING_COLLECTION)
    expect(SPINE_EMBEDDING_COLLECTION).toBe("spine_embeddings")
    expect(SPINE_EMBEDDING_INDEX).toBe("spine_embeddings_vector")
    expect(SpineEmbedding.schema.indexes()).toContainEqual([{ projectId: 1, kind: 1, ref: 1 }, expect.objectContaining({ unique: true })])
  })

  it("đủ field ⇒ hợp lệ; kind lạ / thiếu embedding ⇒ lỗi", () => {
    const base = {
      projectId: new mongoose.Types.ObjectId(),
      kind: "element",
      ref: "use_cases[id=UC-05]",
      entity: "use_cases",
      section_id: "fixed:2.2.2",
      spine_version: 3,
      text: "Use case UC-05: Log out",
      text_hash: "abc",
      embedding: [0.1, 0.2]
    }
    expect(new SpineEmbedding(base).validateSync()).toBeUndefined()
    expect(new SpineEmbedding({ ...base, kind: "chunk" }).validateSync()?.errors.kind).toBeDefined()
    expect(new SpineEmbedding({ ...base, text: undefined }).validateSync()?.errors.text).toBeDefined()
  })
})
