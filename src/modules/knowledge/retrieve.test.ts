import { describe, it, expect } from "vitest"
import { buildFilter, expandToParent, lexicalCoverage, LEXICAL_MIN_COVERAGE, PARENT_EXPAND_MAX_TOKENS, queryTerms, RRF_K, rrfFuse, shouldAbstain, statusesFor } from "./retrieve.js"

describe("rrfFuse (Reciprocal Rank Fusion, k = 60)", () => {
  it("cộng 1/(k + hạng) qua hai danh sách; chunk đứng khá ở cả hai vượt chunk chỉ đứng đầu một danh sách", () => {
    const fused = rrfFuse(
      [
        { chunk_id: "v1", cosine: 0.9 },
        { chunk_id: "both", cosine: 0.8 }
      ],
      ["l1", "both"],
      RRF_K,
      1
    )
    expect(fused[0]).toMatchObject({ chunk_id: "both", vector_rank: 2, lexical_rank: 2, vector_score: 0.8 })
    expect(fused[0]!.rrf).toBeCloseTo(2 / (RRF_K + 2))
    expect(fused.map((f) => f.chunk_id)).toEqual(["both", "v1", "l1"])
  })

  it("bằng điểm ⇒ hạng vector tốt hơn đi trước; một danh sách rỗng thì giữ thứ tự danh sách kia", () => {
    expect(rrfFuse([{ chunk_id: "v", cosine: 0.5 }], ["l"], RRF_K, 1).map((f) => f.chunk_id)).toEqual(["v", "l"])
    expect(rrfFuse([], ["c", "a", "b"], RRF_K, 1).map((f) => f.chunk_id)).toEqual(["c", "a", "b"])
  })

  it("trọng số từ khoá 0 (mặc định theo eval): giữ thứ tự vector, từ khoá chỉ thêm ứng viên ở cuối theo hạng của nó", () => {
    const fused = rrfFuse(
      [
        { chunk_id: "v1", cosine: 0.9 },
        { chunk_id: "both", cosine: 0.8 }
      ],
      ["l2", "both", "l1"],
      RRF_K,
      0
    )
    expect(fused.map((f) => f.chunk_id)).toEqual(["v1", "both", "l2", "l1"])
  })

  it("không có vector (chỉ từ khoá) ⇒ trọng số 1 dù cấu hình 0: giữ đúng thứ tự từ khoá", () => {
    expect(rrfFuse([], ["c", "a", "b"], RRF_K, 0).map((f) => f.chunk_id)).toEqual(["c", "a", "b"])
    expect(rrfFuse([], ["c"], RRF_K, 0)[0]!.rrf).toBeCloseTo(1 / (RRF_K + 1))
  })

  it("id lặp trong một danh sách chỉ tính hạng đầu", () => {
    const fused = rrfFuse([], ["a", "a"], RRF_K, 1)
    expect(fused).toHaveLength(1)
    expect(fused[0]!.rrf).toBeCloseTo(1 / (RRF_K + 1))
  })
})

describe("chỉ từ khoá: độ phủ từ của câu hỏi", () => {
  it("bỏ từ hư / từ ngắn, khớp theo 5 ký tự đầu của từ dài", () => {
    expect(queryTerms("What are the BABOK knowledge areas?")).toEqual(["babok", "knowledge", "areas"])
    expect(lexicalCoverage("use case naming rules", "Use case names: verb + object. Naming follows the rules below.")).toBe(1)
    // câu ngoài kho chỉ chung một từ với chunk lạc đề ⇒ dưới ngưỡng
    expect(lexicalCoverage("BABOK knowledge areas", "Application messages grouped by functional areas")).toBeCloseTo(1 / 3)
    expect(lexicalCoverage("?? !!", "bất kỳ")).toBe(1)
  })

  it("shouldAbstain chỉ từ khoá: có kết quả nhưng phủ dưới ngưỡng ⇒ từ chối; không truyền độ phủ ⇒ như cũ", () => {
    expect(shouldAbstain(null, false, 4, 0.6, 1 / 3)).toBe(true)
    expect(shouldAbstain(null, false, 4, 0.6, LEXICAL_MIN_COVERAGE)).toBe(false)
    expect(shouldAbstain(null, false, 4, 0.6)).toBe(false)
    // có vector thì độ phủ từ không xét
    expect(shouldAbstain(0.7, true, 4, 0.6, 0)).toBe(false)
  })
})

describe("shouldAbstain", () => {
  it("có vector: từ chối khi cosine cao nhất dưới ngưỡng hoặc không có kết quả vector", () => {
    expect(shouldAbstain(0.59, true, 5, 0.6)).toBe(true)
    expect(shouldAbstain(0.6, true, 0, 0.6)).toBe(false)
    expect(shouldAbstain(null, true, 5, 0.6)).toBe(true)
  })

  it("chỉ từ khoá (kể cả backend vector không trả gì): từ chối khi không có kết quả", () => {
    expect(shouldAbstain(null, false, 0, 0.6)).toBe(true)
    expect(shouldAbstain(null, false, 1, 0.6)).toBe(false)
  })
})

describe("expandToParent (small-to-big)", () => {
  const part = (part: number, chars: number) => ({ chunk_id: `p/${part}`, part, text: `${part}`.repeat(chars) })

  it(`section cha ≤ ${PARENT_EXPAND_MAX_TOKENS} token ⇒ cả section theo thứ tự phần`, () => {
    const siblings = [part(1, 100), part(0, 100)]
    expect(expandToParent(siblings[0]!, siblings)).toBe(`${"0".repeat(100)}\n\n${"1".repeat(100)}`)
  })

  it("section cha quá dài hoặc chunk không bị cắt ⇒ chữ của chính chunk", () => {
    const big = [part(0, 2000), part(1, 2000)]
    expect(expandToParent(big[1]!, big)).toBe(big[1]!.text)
    expect(expandToParent({ text: "solo" }, [part(0, 4)])).toBe("solo")
  })
})

describe("bộ lọc metadata", () => {
  it("mặc định chỉ verified; includePlaceholder thêm placeholder; corpus / appliesTo nhận chuỗi hoặc mảng", () => {
    expect(statusesFor(false)).toEqual(["verified"])
    expect(statusesFor(true)).toEqual(["verified", "placeholder"])
    expect(buildFilter({ corpus: "skills" })).toEqual({ corpus: ["skills"], statuses: ["verified"] })
    expect(buildFilter({ corpus: ["a", "b"], appliesTo: "S-3.1", includePlaceholder: true })).toEqual({
      corpus: ["a", "b"],
      statuses: ["verified", "placeholder"],
      appliesTo: ["S-3.1"]
    })
  })
})
