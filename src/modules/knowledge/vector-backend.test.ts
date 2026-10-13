import { describe, it, expect } from "vitest"
import { atlasScoreToCosine, cosine, isVectorSearchUnsupported, knowledgeMongoFilter, searchRows, type MemoryRow } from "./vector-backend.js"

describe("nhận diện Mongo không có $vectorSearch", () => {
  it.each([
    [{ code: 40324, message: "Unrecognized pipeline stage name: '$vectorSearch'" }],
    [{ code: 6047401, message: "x" }],
    [{ code: 31082, codeName: "SearchNotEnabled" }],
    [{ message: "$vectorSearch stage is only allowed on MongoDB Atlas" }],
    [{ message: "Using $listSearchIndexes requires additional configuration" }]
  ])("%o ⇒ không hỗ trợ", (err) => {
    expect(isVectorSearchUnsupported(err)).toBe(true)
  })

  it("lỗi mạng / lỗi khác ⇒ không phải 'không hỗ trợ' (không được nhớ)", () => {
    expect(isVectorSearchUnsupported({ code: 89, message: "connection timed out" })).toBe(false)
    expect(isVectorSearchUnsupported(null)).toBe(false)
  })
})

describe("điểm", () => {
  it("score Atlas (1 + cos) / 2 ⇒ cosine", () => {
    expect(atlasScoreToCosine(1)).toBe(1)
    expect(atlasScoreToCosine(0.5)).toBe(0)
    expect(atlasScoreToCosine(0.8)).toBeCloseTo(0.6)
  })

  it("cosine không phụ thuộc độ dài vector; vector rỗng ⇒ 0", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })
})

describe("searchRows (backend memory)", () => {
  const rows: MemoryRow[] = [
    { chunk_id: "a", corpus: "skills", status: "verified", applies_to: ["S-3.1"], embedding: [1, 0] },
    { chunk_id: "b", corpus: "skills", status: "placeholder", applies_to: [], embedding: [1, 0.1] },
    { chunk_id: "c", corpus: "skills", status: "verified", applies_to: [], embedding: [0.6, 0.8] },
    { chunk_id: "d", corpus: "standards", status: "verified", applies_to: [], embedding: [1, 0] }
  ]

  it("lọc corpus + status trước rồi xếp theo cosine", () => {
    expect(searchRows(rows, [1, 0], { corpus: ["skills"], statuses: ["verified"] }, 10).map((h) => h.chunk_id)).toEqual(["a", "c"])
    expect(searchRows(rows, [1, 0], { corpus: ["skills"], statuses: ["verified", "placeholder"] }, 2).map((h) => h.chunk_id)).toEqual(["a", "b"])
  })

  it("appliesTo chỉ giữ chunk có step giao", () => {
    expect(searchRows(rows, [1, 0], { corpus: ["skills"], statuses: ["verified"], appliesTo: ["S-3.1"] }, 10).map((h) => h.chunk_id)).toEqual(["a"])
  })

  it("bộ lọc Mongo cùng ngữ nghĩa", () => {
    expect(knowledgeMongoFilter({ corpus: ["skills"], statuses: ["verified"], appliesTo: ["S-3.1"] })).toEqual({
      corpus: { $in: ["skills"] },
      status: { $in: ["verified"] },
      applies_to: { $in: ["S-3.1"] }
    })
    expect(knowledgeMongoFilter({ corpus: ["skills"], statuses: ["verified"] })).not.toHaveProperty("applies_to")
  })
})
