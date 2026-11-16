import { describe, expect, it } from "vitest"
import { foldDiacritics, tokenize, tokenizeText } from "./vi-tokenizer.js"

describe("vi-tokenizer (FLF-393)", () => {
  it("giữ mã nguyên khối, mọi cách viết về một token", () => {
    for (const text of ["UC-12", "uc12", "UC_012", "UC 12", "Uc-12"]) expect(tokenize(text)).toEqual(["uc-12"])
    expect(tokenizeText("Xem UC-05 và FR-03.").codes).toEqual(["uc-5", "fr-3"])
  })

  it("không biến chữ thường + số cách nhau thành mã", () => {
    const { tokens, codes } = tokenizeText("xem trang 12 của tài liệu")
    expect(codes).toEqual([])
    expect(tokens).toContain("trang")
    expect(tokens).toContain("12")
  })

  it("UC-12 khác UC-21", () => {
    expect(tokenize("UC-12")).not.toEqual(tokenize("UC-21"))
  })

  it("phát cả bản có dấu, bản bỏ dấu và bigram", () => {
    expect(tokenize("Đăng nhập")).toEqual(["đăng", "dang", "nhập", "nhap", "dang_nhap"])
    expect(tokenize("dang nhap")).toEqual(["dang", "nhap", "dang_nhap"])
  })

  it("chuẩn hoá NFC: chữ tổ hợp và chữ dựng sẵn ra cùng token", () => {
    const composed = "đặt lịch"
    const decomposed = composed.normalize("NFD")
    expect(decomposed).not.toBe(composed)
    expect(tokenize(decomposed)).toEqual(tokenize(composed))
  })

  it("bỏ từ hư và token một ký tự; từ hư, dấu câu cắt bigram", () => {
    expect(tokenize("màn hình của khách hàng")).toEqual(["màn", "man", "hình", "hinh", "man_hinh", "khách", "khach", "hàng", "hang", "khach_hang"])
    expect(tokenize("thanh toán, hoàn tiền")).not.toContain("toan_hoan")
    expect(tokenize("a b")).toEqual([])
  })

  it("đếm từ có nghĩa cho câu hỏi ngắn", () => {
    expect(tokenizeText("còn cái kia thì sao").wordCount).toBe(2)
    expect(tokenizeText("UC-12 làm gì").wordCount).toBe(2)
  })

  it("foldDiacritics", () => {
    expect(foldDiacritics("Đặt lịch khám")).toBe("Dat lich kham")
  })
})
