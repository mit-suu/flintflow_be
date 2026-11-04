import { describe, expect, it } from "vitest"
import { displayHeading } from "./heading-label.js"

describe("displayHeading (FLF-362)", () => {
  it("ghép nhãn số Word + chữ; chữ đã gõ số tay / không có nhãn ⇒ giữ nguyên", () => {
    expect(displayHeading("Actors", "2.1.")).toBe("2.1. Actors")
    expect(displayHeading("Introduction", "I.")).toBe("I. Introduction")
    expect(displayHeading("2.1 Actors", "2.1.")).toBe("2.1 Actors")
    expect(displayHeading("Actors", null)).toBe("Actors")
    expect(displayHeading("  Actors  ", " ")).toBe("Actors")
  })
})
