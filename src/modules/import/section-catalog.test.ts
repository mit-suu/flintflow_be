import { describe, expect, it } from "vitest"
import { catalogSectionOf } from "./section-catalog.js"

describe("catalogSectionOf (FLF-491)", () => {
  it("tên trùng danh mục (bỏ số mục) ⇒ id mục khung", () => {
    expect(catalogSectionOf("1 Tổng quan sản phẩm")).toBe("fixed:1")
    expect(catalogSectionOf("5.5 Thuật ngữ")).toBe("fixed:5.5")
  })
  it("tên là chỗ điền ⇒ theo số mục", () => {
    expect(catalogSectionOf("4.2.4 …")).toBe("fixed:4.2.4")
    expect(catalogSectionOf("9.9 …")).toBeNull()
  })
  it("không so gần đúng", () => {
    expect(catalogSectionOf("Mục tiêu dự án")).toBeNull()
    expect(catalogSectionOf("Phạm vi phát hành 1.0")).toBeNull()
  })
})
