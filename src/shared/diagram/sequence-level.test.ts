import { describe, expect, it } from "vitest"
import { DEFAULT_SEQUENCE_LEVEL, sequenceLevelChosen, sequenceLevelOf, toSequenceLevel } from "./sequence-level.js"

describe("sequence-level (FLF-418)", () => {
  it("chỉ nhận system | component; thiếu / lạ ⇒ vẽ system và coi là chưa chọn", () => {
    expect(toSequenceLevel("component")).toBe("component")
    expect(toSequenceLevel("Component")).toBeNull()
    expect(sequenceLevelOf(undefined)).toBe(DEFAULT_SEQUENCE_LEVEL)
    expect(sequenceLevelOf({ sequenceLevel: "uml" })).toBe("system")
    expect(sequenceLevelChosen({})).toBe(false)
    expect(sequenceLevelChosen({ sequenceLevel: "system" })).toBe(true)
  })
})
