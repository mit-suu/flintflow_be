import { describe, expect, it } from "vitest"
import { projectCode } from "./project-code.js"

describe("projectCode", () => {
  it("P + 6 ký tự cuối của _id, viết hoa", () => {
    expect(projectCode("6b06a5422016da645777049b")).toBe("P77049B")
    expect(projectCode("abcdef")).toBe("PABCDEF")
  })
})
