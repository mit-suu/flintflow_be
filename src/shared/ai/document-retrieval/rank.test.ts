import { describe, expect, it } from "vitest"
import { buildBm25 } from "./bm25.js"
import { CODE_WEIGHT, rankChunks } from "./rank.js"
import { tokenize } from "./vi-tokenizer.js"

/** Tài liệu mà "use case", "tài liệu", "nguồn" có mặt ở nhiều đoạn — như SRS thật. */
const filler = (i: number) => `Đoạn ${i}: tài liệu mô tả use case của hệ thống, quy tắc nghiệp vụ, mã đoạn nguồn và đặc tả chi tiết.`
const DOCS = [
  ...Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, text: `${filler(i)} ${filler(i + 100)}` })),
  { id: "uc5", text: "UC-05 Change Password: Registered User changes the password while logged in." },
  { id: "br2", text: "BR-02 Lead succession: an organization always has at least one Lead." }
]
const index = buildBm25(DOCS, tokenize)
const QUESTION = "Ý tưởng nằm trong tài liệu SRS mình đã tải lên. Cho mình biết UC-05 là use case gì và quy tắc BR-02 nói gì, kèm mã đoạn nguồn."

describe("rankChunks (FLF-393)", () => {
  it("mã trong câu hỏi dài, tự nhiên vẫn kéo đúng đoạn lên đầu", () => {
    const top = rankChunks(index, QUESTION, 5).map((h) => h.id)
    expect(top.slice(0, 2).sort()).toEqual(["br2", "uc5"])
  })

  it("trọng số mã nâng điểm đoạn chứa mã, đoạn không chứa mã giữ nguyên điểm", () => {
    expect(CODE_WEIGHT).toBeGreaterThan(1)
    const score = (weight: number, id: string) => rankChunks(index, QUESTION, 50, weight).find((h) => h.id === id)!.score
    expect(score(CODE_WEIGHT, "uc5")).toBeGreaterThan(score(1, "uc5") * 2)
    expect(score(CODE_WEIGHT, "f0")).toBeCloseTo(score(1, "f0"))
  })

  it("câu hỏi rỗng / chỉ từ hư ⇒ rỗng", () => {
    expect(rankChunks(index, "", 5)).toEqual([])
    expect(rankChunks(index, "là của và", 5)).toEqual([])
  })
})
