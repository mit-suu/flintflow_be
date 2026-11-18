import { describe, expect, it } from "vitest"
import { buildBm25 } from "./bm25.js"
import { rankChunks } from "./rank.js"
import { crossLanguageTerms, expandCrossLanguage } from "./vi-en-terms.js"
import { tokenize } from "./vi-tokenizer.js"

describe("vi-en-terms (FLF-393)", () => {
  it("câu tiếng Việt (có hoặc không dấu) ⇒ thêm thuật ngữ tiếng Anh", () => {
    expect(crossLanguageTerms("Tài liệu có nói cổng thanh toán nào không?")).toEqual(expect.arrayContaining(["payment", "payment gateway"]))
    expect(crossLanguageTerms("doi mat khau")).toEqual(expect.arrayContaining(["password"]))
  })

  it("câu tiếng Anh ⇒ thêm thuật ngữ tiếng Việt", () => {
    expect(crossLanguageTerms("how does login work")).toEqual(expect.arrayContaining(["đăng nhập"]))
  })

  it("so theo ranh giới từ, không lặp cụm đã có, không khớp gì ⇒ giữ nguyên câu", () => {
    expect(crossLanguageTerms("payment gateway")).not.toContain("payment gateway")
    expect(crossLanguageTerms("UC-05")).toEqual([])
    expect(expandCrossLanguage("UC-05")).toBe("UC-05")
  })

  it("câu hỏi tiếng Việt tìm được đoạn tiếng Anh", () => {
    const index = buildBm25(
      [
        { id: "pay", text: "The Payment Gateway (VietQR / SePay checkout) processes credit pack purchases." },
        { id: "pwd", text: "UC-05 Change Password: the user changes the password while logged in." },
        { id: "other", text: "The glossary lists every term used in the document." }
      ],
      tokenize
    )
    expect(rankChunks(index, "hệ thống nhận thanh toán qua cổng nào?", 1)[0]?.id).toBe("pay")
    expect(rankChunks(index, "đổi mật khẩu thế nào", 1)[0]?.id).toBe("pwd")
  })
})
