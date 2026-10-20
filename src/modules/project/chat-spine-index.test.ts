import { describe, expect, it } from "vitest"
import { buildChatSpineIndex, SPINE_INDEX_MAX_CHARS, SPINE_INDEX_MAX_ITEMS } from "./chat-spine-index.js"

const uc = (n: number) => ({ id: `UC${String(n).padStart(2, "0")}`, name: `Use Case ${n}`, actor_ids: [], function_ids: [], description: "secret prose", includes: [], extends: [] })

describe("buildChatSpineIndex", () => {
  it("không có Spine ⇒ chuỗi rỗng", () => {
    expect(buildChatSpineIndex(null)).toBe("")
  })

  it("đếm và liệt kê mã + tên, không lộ mô tả", () => {
    const text = buildChatSpineIndex({ use_cases: [uc(1), uc(2)], nfrs: [{ id: "N1", category: "other", statement: "x", kind: "descriptive", priority: null }] })
    expect(text).toContain("- Use cases: 2 — UC01 Use Case 1; UC02 Use Case 2")
    expect(text).toContain("- Non-functional requirements: 1")
    expect(text).toContain("- Actors: 0")
    expect(text).not.toContain("secret prose")
  })

  it("quá trần phần tử ⇒ ghi phần còn lại dạng +N", () => {
    const text = buildChatSpineIndex({ use_cases: Array.from({ length: SPINE_INDEX_MAX_ITEMS + 5 }, (_, i) => uc(i + 1)) })
    expect(text).toContain(`- Use cases: ${SPINE_INDEX_MAX_ITEMS + 5} —`)
    expect(text).toContain("; +5")
  })

  it("không vượt trần ký tự", () => {
    const long = (p: string) => Array.from({ length: SPINE_INDEX_MAX_ITEMS }, (_, i) => ({ id: `${p}${i}`, name: "N".repeat(60) }))
    const text = buildChatSpineIndex({ features: long("F") as never, actors: long("A") as never, screens: long("S") as never, functions: long("FN") as never })
    expect(text.length).toBeLessThanOrEqual(SPINE_INDEX_MAX_CHARS + 4)
    expect(text.endsWith("- …")).toBe(true)
  })
})
