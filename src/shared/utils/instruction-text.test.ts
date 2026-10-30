import { describe, expect, it } from "vitest"
import { isInstructionText, isRealText, tableHasRealText } from "./instruction-text.js"

describe("instruction-text", () => {
  it("nhận chữ hướng dẫn trong ngoặc / câu mô tả mục; nội dung thật thì không", () => {
    expect(isInstructionText("[Describe the TLS version, certificate pinning…]")).toBe(true)
    expect(isInstructionText("<<Product name>>")).toBe(true)
    expect(isInstructionText("This section describes the scope.")).toBe(true)
    expect(isInstructionText("Mục này mô tả phạm vi.")).toBe(true)
    expect(isInstructionText("The app uses TLS 1.3 [RFC 8446].")).toBe(false)
    expect(isRealText("  ")).toBe(false)
    expect(isRealText("[Name]")).toBe(false)
    expect(isRealText("Retail customer")).toBe(true)
  })

  it("bảng toàn ô chỗ trống không phải nội dung", () => {
    expect(tableHasRealText([["Role", "Name"], ["", "[Name]"]])).toBe(true)
    expect(tableHasRealText([["[x.y]", "[dd/mm/yyyy]"], ["", " "]])).toBe(false)
    expect(tableHasRealText(null)).toBe(false)
  })
})
