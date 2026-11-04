import { describe, expect, it } from "vitest"
import { isInstructionText, isRealText, splitInstruction, tableHasRealText } from "./instruction-text.js"

describe("instruction-text", () => {
  it("FLF-364: chỉ chữ trong [ ] / { } là hướng dẫn; ngoặc tròn, < >, câu mô tả mục là nội dung", () => {
    expect(isInstructionText("[Describe the TLS version, certificate pinning…]")).toBe(true)
    expect(isInstructionText("{Ghi chú cho người soạn: liệt kê tài liệu}")).toBe(true)
    expect(isInstructionText("{{project name}}")).toBe(true)
    expect(isInstructionText("<<Product name>>")).toBe(false)
    expect(isInstructionText("(optional)")).toBe(false)
    expect(isInstructionText("<= 24 h (<= 6 h during exam week)")).toBe(false)
    expect(isInstructionText("This section describes the scope.")).toBe(false)
    expect(isInstructionText("Mục này mô tả phạm vi.")).toBe(false)
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

  it("splitInstruction: cả đoạn trong ngoặc ⇒ toàn hướng dẫn; ngoặc trong câu có chữ thật ⇒ tách; dẫn chiếu ngắn giữ nguyên", () => {
    expect(splitInstruction("[Mô tả mục đích của tài liệu và người đọc]")).toEqual({ text: "", guidance: ["Mô tả mục đích của tài liệu và người đọc"] })
    expect(splitInstruction("{{project name}}")).toEqual({ text: "", guidance: ["project name"] })
    expect(splitInstruction("Hệ thống quản lý học sinh [ghi rõ phạm vi trường áp dụng].")).toEqual({
      text: "Hệ thống quản lý học sinh.",
      guidance: ["ghi rõ phạm vi trường áp dụng"]
    })
    expect(splitInstruction("Giáo viên nhập điểm {liệt kê vai trò khác nếu có} theo kỳ")).toEqual({
      text: "Giáo viên nhập điểm theo kỳ",
      guidance: ["liệt kê vai trò khác nếu có"]
    })
    expect(splitInstruction("The app uses TLS 1.3 [RFC 8446].")).toEqual({ text: "The app uses TLS 1.3 [RFC 8446].", guidance: [] })
    expect(splitInstruction("")).toEqual({ text: "", guidance: [] })
  })
})
