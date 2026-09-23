import { describe, expect, it } from "vitest"
import { hasElementSchema, withElementDefaults } from "./element-defaults.js"

describe("withElementDefaults", () => {
  it("BUG-04: use case thiếu mảng tham chiếu ⇒ điền []", () => {
    const value = withElementDefaults("use_cases", { id: "UC18", name: "Send Reminder", description: "…" }) as Record<string, unknown>
    expect(value).toMatchObject({ actor_ids: [], function_ids: [], includes: [], extends: [] })
  })

  it("function thiếu mảng và priority ⇒ [] và null; field đã có giữ nguyên", () => {
    const value = withElementDefaults("functions", { id: "FN010", name: "Cancel", normal: ["a"] }) as Record<string, unknown>
    expect(value).toMatchObject({ normal: ["a"], abnormal: [], validations: [], business_rule_ids: [], priority: null })
  })

  it("không tự điền field nullable mang nghĩa (screen_id, feature_id)", () => {
    const value = withElementDefaults("functions", { id: "FN010" }) as Record<string, unknown>
    expect("screen_id" in value).toBe(false)
    expect("feature_id" in value).toBe(false)
  })

  it("collection lạ hoặc giá trị vô hướng ⇒ trả nguyên", () => {
    expect(hasElementSchema("steps")).toBe(false)
    expect(withElementDefaults("steps", { id: "S-1.1" })).toEqual({ id: "S-1.1" })
    expect(withElementDefaults("screens", "S01")).toBe("S01")
  })
})
