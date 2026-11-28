import { describe, expect, it } from "vitest"
import {
  guidanceVerdict,
  isCertainGuidance,
  isInstructionText,
  isRealText,
  knownGuidanceMatcher,
  splitInstruction,
  tableBodyHasRealText,
  tableHasRealText,
  textGuidanceSignals
} from "./instruction-text.js"

describe("instruction-text", () => {
  // FLF-459: `isInstructionText` chỉ còn là mẫu ngoặc (một dấu hiệu) — file upload nhận diện theo lớp (`guidanceVerdict` bên dưới)
  it("FLF-364: mẫu ngoặc chỉ khớp chữ trong [ ] / { }; ngoặc tròn, < >, câu mô tả mục không khớp", () => {
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

  it("FLF-278: bảng mẫu = tiêu đề + hàng chỗ trống ⇒ không có nội dung; bảng một hàng xét như nhãn | giá trị", () => {
    expect(tableBodyHasRealText([["ID", "Requirement", "Priority"], ["[FR-xxx]", "[Describe the requirement.]", "[High/Medium/Low]"]])).toBe(false)
    expect(tableBodyHasRealText([["ID", "Requirement", "Priority"]])).toBe(true)
    expect(tableBodyHasRealText([["ID", "Requirement"], ["FR-01", "Members can join a club"]])).toBe(true)
    expect(tableBodyHasRealText([["Role", "[Name]"]])).toBe(false)
    expect(tableBodyHasRealText([["Role", "Admin"]])).toBe(true)
    expect(tableBodyHasRealText(null)).toBe(false)
  })

  describe("FLF-459 - nhận diện chữ hướng dẫn theo lớp (business-flow §3.1.1)", () => {
    it("dấu hiệu từ chữ: ngoặc trọn đoạn [ ] { } << >>, câu kiểu 'Mục này mô tả…' (kể cả trong ngoặc); ngoặc trong câu không tính", () => {
      expect(textGuidanceSignals("[Describe the scope]")).toEqual(["brackets"])
      expect(textGuidanceSignals("{{project name}}")).toEqual(["brackets"])
      expect(textGuidanceSignals("<<Mô tả sản phẩm>>")).toEqual(["brackets"])
      expect(textGuidanceSignals("Mục này mô tả phạm vi.")).toEqual(["describes"])
      expect(textGuidanceSignals("This section describes the scope.")).toEqual(["describes"])
      expect(textGuidanceSignals("[This section describes the scope.]")).toEqual(["brackets", "describes"])
      expect(textGuidanceSignals("Hệ thống quản lý học sinh [ghi rõ phạm vi trường áp dụng].")).toEqual([])
      expect(textGuidanceSignals("Giáo viên nhập điểm theo kỳ.")).toEqual([])
    })

    it("lớp 1 chắc chắn, không cần dấu hiệu khác", () => {
      expect(guidanceVerdict({ text: "Bấm vào đây để nhập", certain: "placeholder" })).toEqual({ layer: 1, signals: ["placeholder"] })
      expect(guidanceVerdict({ text: "Mô tả phạm vi", certain: "style" })?.layer).toBe(1)
      expect(guidanceVerdict({ text: "Ghi chú ẩn", certain: "hidden" })?.layer).toBe(1)
    })

    it("lớp 2: trùng / gần trùng câu hướng dẫn của mẫu đã biết, kể cả không ngoặc; câu ngắn không so", () => {
      const known = knownGuidanceMatcher(["[Provide the descriptions for the screens in the Screens Flow above]", "Liệt kê mọi tác nhân của hệ thống. Ghi rõ vai trò từng tác nhân."])
      expect(guidanceVerdict({ text: "Provide the descriptions for the screens in the Screens Flow above", known })).toEqual({ layer: 2, signals: ["known"] })
      expect(guidanceVerdict({ text: "[Provide descriptions for the screens in the Screen Flow above]", known })?.layer).toBe(2)
      expect(guidanceVerdict({ text: "Liet ke moi tac nhan cua he thong.", known })?.layer).toBe(2)
      expect(guidanceVerdict({ text: "The screens are listed in the table below with their owners", known })).toBeNull()
      expect(knownGuidanceMatcher(["[Name]"])("[Name]")).toBe(false)
      expect(knownGuidanceMatcher([])("Provide the descriptions for the screens")).toBe(false)
    })

    it("lớp 3: từ 2 dấu hiệu — ngoặc + in nghiêng là hướng dẫn; ngoặc + câu mô tả; màu + nghiêng", () => {
      expect(guidanceVerdict({ text: "[Describe the scope]", format: ["italic"] })).toEqual({ layer: 3, signals: ["italic", "brackets"] })
      expect(guidanceVerdict({ text: "[Mục này mô tả phạm vi hệ thống]" })).toEqual({ layer: 3, signals: ["brackets", "describes"] })
      expect(guidanceVerdict({ text: "Ghi chú cho người soạn", format: ["italic", "color"] })?.layer).toBe(3)
    })

    it("lớp 4: đúng 1 dấu hiệu (chỉ có ngoặc, chỉ in nghiêng, chỉ câu mô tả) ⇒ chưa kết luận, không là hướng dẫn (đảo FLF-364)", () => {
      expect(guidanceVerdict({ text: "[Describe the TLS version, certificate pinning…]" })).toEqual({ layer: 4, signals: ["brackets"] })
      expect(guidanceVerdict({ text: "Tài liệu dành cho giáo viên.", format: ["italic"] })).toEqual({ layer: 4, signals: ["italic"] })
      expect(guidanceVerdict({ text: "This section describes the scope." })?.layer).toBe(4)
      expect(isCertainGuidance(4)).toBe(false)
      expect([1, 2, 3].every((l) => isCertainGuidance(l as 1 | 2 | 3))).toBe(true)
    })

    it("không dấu hiệu / đoạn trống ⇒ nội dung thật (null)", () => {
      expect(guidanceVerdict({ text: "Giáo viên nhập điểm theo kỳ." })).toBeNull()
      expect(guidanceVerdict({ text: "  ", certain: "style" })).toBeNull()
      expect(isCertainGuidance(null)).toBe(false)
    })
  })
})
