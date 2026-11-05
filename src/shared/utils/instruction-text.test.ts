import { describe, expect, it } from "vitest"
import { isInstructionText, isRealText, tableBodyHasRealText, tableHasRealText } from "./instruction-text.js"

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

  it("FLF-278: bảng mẫu = tiêu đề + hàng chỗ trống ⇒ không có nội dung; bảng một hàng xét như nhãn | giá trị", () => {
    expect(tableBodyHasRealText([["ID", "Requirement", "Priority"], ["[FR-xxx]", "[Describe the requirement.]", "[High/Medium/Low]"]])).toBe(false)
    expect(tableBodyHasRealText([["ID", "Requirement", "Priority"]])).toBe(true)
    expect(tableBodyHasRealText([["ID", "Requirement"], ["FR-01", "Members can join a club"]])).toBe(true)
    expect(tableBodyHasRealText([["Role", "[Name]"]])).toBe(false)
    expect(tableBodyHasRealText([["Role", "Admin"]])).toBe(true)
    expect(tableBodyHasRealText(null)).toBe(false)
  })
})
