import { describe, expect, it } from "vitest"
import { foldVietnamese, vietnameseSearchPattern } from "./vi-search.js"

describe("vi-search", () => {
  it("bỏ dấu và chữ thường, kể cả đ", () => {
    expect(foldVietnamese("Ngân Hàng Đông Á")).toBe("ngan hang dong a")
  })

  it("gõ không dấu vẫn khớp chữ có dấu, hoa thường đều được", () => {
    const pattern = vietnameseSearchPattern("ngan hang")
    expect(pattern.test("IEEE 29148 — Ngân hàng số")).toBe(true)
    expect(pattern.test("NGÂN HÀNG")).toBe(true)
    expect(pattern.test("Logistics")).toBe(false)
  })

  it("gõ có dấu cũng khớp; đ khớp cả d", () => {
    expect(vietnameseSearchPattern("Bệnh viện").test("benh vien HIS")).toBe(true)
    expect(vietnameseSearchPattern("dong").test("Đông Á")).toBe(true)
  })

  it("ký tự đặc biệt của regex được hiểu theo nghĩa đen", () => {
    expect(vietnameseSearchPattern("a.b").test("axb")).toBe(false)
    expect(vietnameseSearchPattern("(v2)").test("core (v2).docx")).toBe(true)
  })
})
