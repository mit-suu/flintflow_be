import { describe, expect, it } from "vitest"
import { DEFAULT_ERD_NOTATION, ERD_NOTATIONS, erdNotationOf, toErdNotation } from "./erd-notation.js"

describe("erd-notation", () => {
  it("ba ký pháp, mặc định chen", () => {
    expect(ERD_NOTATIONS).toEqual(["chen", "crowsfoot", "idef1x"])
    expect(DEFAULT_ERD_NOTATION).toBe("chen")
  })

  it("toErdNotation chỉ nhận đúng giá trị; erdNotationOf: thiếu / lạ ⇒ chen", () => {
    expect(toErdNotation("crowsfoot")).toBe("crowsfoot")
    for (const bad of ["Chen", "uml", "", null, undefined, 1, {}]) expect(toErdNotation(bad)).toBeNull()
    expect(erdNotationOf({ erdNotation: "idef1x" })).toBe("idef1x")
    expect(erdNotationOf({})).toBe("chen")
    expect(erdNotationOf({ erdNotation: "uml" })).toBe("chen")
    expect(erdNotationOf(null)).toBe("chen")
    expect(erdNotationOf(undefined)).toBe("chen")
  })
})
