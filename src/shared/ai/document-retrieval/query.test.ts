import { describe, expect, it } from "vitest"
import { chatDocumentQuery, isGlobalQuestion } from "./query.js"

describe("isGlobalQuestion (FLF-393)", () => {
  it("câu hỏi về cả tài liệu, có dấu / không dấu / tiếng Anh", () => {
    for (const q of ["Tóm tắt tài liệu giúp mình", "tom tat tai lieu", "Có bao nhiêu use case?", "liệt kê tất cả màn hình", "Give me an overview", "how many actors"]) {
      expect(isGlobalQuestion(q), q).toBe(true)
    }
  })

  it("câu hỏi cụ thể thì không", () => {
    for (const q of ["UC-12 làm gì", "màn hình đặt lịch có những trường nào", "quy tắc hoàn tiền"]) expect(isGlobalQuestion(q), q).toBe(false)
  })
})

describe("chatDocumentQuery (FLF-393)", () => {
  const history = [
    { role: "user", content: "UC-05 Đặt lịch khám có luồng thay thế nào?" },
    { role: "ai", content: JSON.stringify({ reply: "UC-05 có luồng huỷ lịch.", questions: [] }) }
  ]

  it("tin đủ dài hoặc có mã ⇒ dùng nguyên tin", () => {
    expect(chatDocumentQuery("quy tắc hoàn tiền khi huỷ lịch", history)).toBe("quy tắc hoàn tiền khi huỷ lịch")
    expect(chatDocumentQuery("UC-12?", history)).toBe("UC-12?")
  })

  it("tin quá ngắn ⇒ nối các lượt trước; tin AI dạng JSON chỉ lấy reply", () => {
    const q = chatDocumentQuery("còn cái kia thì sao", history)
    expect(q).toContain("còn cái kia thì sao")
    expect(q).toContain("UC-05 Đặt lịch khám")
    expect(q).toContain("UC-05 có luồng huỷ lịch.")
    expect(q).not.toContain('"questions"')
  })

  it("không có lịch sử ⇒ chỉ tin nhắn", () => {
    expect(chatDocumentQuery("sao vậy")).toBe("sao vậy")
  })
})
