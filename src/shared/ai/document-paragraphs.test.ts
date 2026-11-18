import { describe, expect, it } from "vitest"
import { LONG_BLOCK_CHARS, formatCodedParagraphs, paragraphId, parseParagraphId, splitParagraphs } from "./document-paragraphs.js"

describe("splitParagraphs", () => {
  it("cắt theo dòng trống, bỏ đoạn rỗng và khoảng trắng thừa", () => {
    expect(splitParagraphs("Mở đầu\n\n  Nội dung 1  \n\n\n\nNội dung 2\n")).toEqual(["Mở đầu", "Nội dung 1", "Nội dung 2"])
  })

  it("dòng trống chỉ có dấu cách / tab vẫn là ranh giới; CRLF như LF", () => {
    expect(splitParagraphs("A\r\n \t\r\nB\r\nB2")).toEqual(["A", "B\nB2"])
  })

  it("khối dài hơn ngưỡng cắt tiếp theo từng dòng (transcript không có dòng trống)", () => {
    const line = "PM: " + "x".repeat(200)
    const transcript = Array.from({ length: 5 }, () => line).join("\n")
    expect(transcript.length).toBeGreaterThan(LONG_BLOCK_CHARS)
    expect(splitParagraphs(transcript)).toEqual(Array.from({ length: 5 }, () => line))
  })

  it("chữ rỗng ⇒ không có đoạn", () => {
    expect(splitParagraphs("  \n\n ")).toEqual([])
  })
})

describe("paragraphId / parseParagraphId", () => {
  it("mã 1-based, ít nhất 2 chữ số", () => {
    expect(paragraphId(1, 0)).toBe("D1-P01")
    expect(paragraphId(12, 104)).toBe("D12-P105")
  })

  it("đọc ngược mã, chấp nhận chữ thường và khoảng trắng", () => {
    expect(parseParagraphId("D1-P03")).toEqual({ docCode: 1, index: 2 })
    expect(parseParagraphId(" d2-p10 ")).toEqual({ docCode: 2, index: 9 })
  })

  it("sai khuôn ⇒ null", () => {
    for (const bad of ["D0-P01", "D1-P00", "D1-P1", "P01", "D1P01", "K1", ""]) expect(parseParagraphId(bad), bad).toBeNull()
  })
})

describe("formatCodedParagraphs", () => {
  it("mỗi đoạn một dòng kèm mã; mã khớp vị trí của splitParagraphs", () => {
    const text = "Biên bản họp\n\nKhách hàng muốn thanh toán COD.\n\nCần app mobile."
    expect(formatCodedParagraphs(3, text)).toBe("[D3-P01] Biên bản họp\n[D3-P02] Khách hàng muốn thanh toán COD.\n[D3-P03] Cần app mobile.")
  })
})
