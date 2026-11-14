import { describe, expect, it } from "vitest"
import { shouldUnsetErdNotation } from "./migrate-erd-notation-unset.js"

describe("shouldUnsetErdNotation (FLF-418)", () => {
  it("chen do default cũ, chưa có ERD, chưa trả lời ⇒ gỡ để S-4.5 hỏi", () => {
    expect(shouldUnsetErdNotation({ erdNotation: "chen" }, { diagrams: [{ kind: "usecase" }], decisions: [] })).toBe(true)
    expect(shouldUnsetErdNotation({ erdNotation: "chen" }, null)).toBe(true)
  })

  it("đã có ERD, đã trả lời câu hỏi ký pháp, hoặc ký pháp khác chen ⇒ giữ", () => {
    expect(shouldUnsetErdNotation({ erdNotation: "chen" }, { diagrams: [{ kind: "erd" }] })).toBe(false)
    expect(shouldUnsetErdNotation({ erdNotation: "chen" }, { decisions: [{ topic_key: "erd_notation" }] })).toBe(false)
    expect(shouldUnsetErdNotation({ erdNotation: "crowsfoot" }, null)).toBe(false)
    expect(shouldUnsetErdNotation({}, null)).toBe(false)
  })
})
