import { describe, it, expect } from "vitest"
import { buildBm25, searchBm25, tokenizeForBm25 } from "./bm25.js"

describe("BM25 trong process (chỉ eval)", () => {
  it("tách từ chữ thường, bỏ stopword, gộp hậu tố số nhiều", () => {
    expect(tokenizeForBm25("The Rules of naming Use Cases")).toEqual(["rule", "nam", "use", "case"])
  })

  it("xếp chunk khớp nhiều từ hiếm lên đầu; không khớp từ nào thì không trả", () => {
    const index = buildBm25([
      { id: "a", text: "Glossary entries define domain terms" },
      { id: "b", text: "Use case names are Title Case with at most five words" },
      { id: "c", text: "Use case relationships include and extend" }
    ])
    const hits = searchBm25(index, "use case names", 10)
    expect(hits[0]!.id).toBe("b")
    expect(hits.map((h) => h.id)).not.toContain("a")
    expect(searchBm25(index, "kubernetes", 10)).toEqual([])
  })

  it("giới hạn số kết quả và thứ tự tất định khi bằng điểm", () => {
    const index = buildBm25([
      { id: "y", text: "credit" },
      { id: "x", text: "credit" }
    ])
    expect(searchBm25(index, "credit", 1)).toEqual([{ id: "x", score: expect.any(Number) }])
  })
})
