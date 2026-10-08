import { describe, it, expect } from "vitest"
import { buildFilter, expandToParent, PARENT_EXPAND_MAX_TOKENS, RRF_K, rrfFuse, shouldAbstain, statusesFor } from "./retrieve.js"

describe("rrfFuse (Reciprocal Rank Fusion, k = 60)", () => {
  it("cộng 1/(k + hạng) qua hai danh sách; chunk đứng khá ở cả hai vượt chunk chỉ đứng đầu một danh sách", () => {
    const fused = rrfFuse(
      [
        { chunk_id: "v1", cosine: 0.9 },
        { chunk_id: "both", cosine: 0.8 }
      ],
      ["l1", "both"]
    )
    expect(fused[0]).toMatchObject({ chunk_id: "both", vector_rank: 2, lexical_rank: 2, vector_score: 0.8 })
    expect(fused[0]!.rrf).toBeCloseTo(2 / (RRF_K + 2))
    expect(fused.map((f) => f.chunk_id)).toEqual(["both", "v1", "l1"])
  })

  it("bằng điểm ⇒ hạng vector tốt hơn đi trước; một danh sách rỗng thì giữ thứ tự danh sách kia", () => {
    expect(rrfFuse([{ chunk_id: "v", cosine: 0.5 }], ["l"]).map((f) => f.chunk_id)).toEqual(["v", "l"])
    expect(rrfFuse([], ["c", "a", "b"]).map((f) => f.chunk_id)).toEqual(["c", "a", "b"])
  })

  it("id lặp trong một danh sách chỉ tính hạng đầu", () => {
    const fused = rrfFuse([], ["a", "a"])
    expect(fused).toHaveLength(1)
    expect(fused[0]!.rrf).toBeCloseTo(1 / (RRF_K + 1))
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
