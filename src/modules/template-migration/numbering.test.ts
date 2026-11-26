import { describe, expect, it } from "vitest"
import { numberingOfHeadings, renumberEntries, type NumberedEntry } from "./numbering.js"

const t = (heading_text: string, level: number): NumberedEntry => ({ heading_text, level, kind: "target" })
const o = (heading_text: string, level: number, kind = "follower"): NumberedEntry => ({ heading_text, level, kind })

describe("numberingOfHeadings", () => {
  it("≥ một nửa heading có số gõ tay ⇒ text; còn lại ⇒ none", () => {
    expect(numberingOfHeadings([{ heading_text: "1. Giới thiệu" }, { heading_text: "1.1 Mục đích" }, { heading_text: "Phụ lục" }])).toBe("text")
    expect(numberingOfHeadings([{ heading_text: "Introduction" }, { heading_text: "Purpose" }, { heading_text: "2 Scope" }])).toBe("none")
    expect(numberingOfHeadings([])).toBe("none")
  })
})

describe("renumberEntries — mẫu đánh số bằng chữ", () => {
  const entries = [
    t("3. Yêu cầu", 1),
    t("3.2 Chức năng", 2),
    o("3.2 Tài khoản và truy cập", 3),
    o("3.2.1 Đăng nhập", 4),
    o("Kích hoạt chức năng", 5),
    o("3.3 Khám phá sản phẩm", 3),
    o("3.3.1 Duyệt trang chủ", 4),
    o("2.2.2 Đặc tả use case", 3, "moved"),
    t("3.3 Chất lượng dịch vụ", 2),
    t("3.3.1 Hiệu năng", 3),
    t("3.3.5 Khả năng quan sát", 3),
    o("4.2.1 Tính khả dụng", 3, "moved"),
    o("Mục tiêu", 3, "moved")
  ]

  it("heading cũ có số nhận số theo heading cha; heading mẫu giữ chữ và chiếm chỗ", () => {
    const { texts } = renumberEntries(entries, "text")
    expect(texts).toEqual([
      "3. Yêu cầu",
      "3.2 Chức năng",
      "3.2.1 Tài khoản và truy cập",
      "3.2.1.1 Đăng nhập",
      "Kích hoạt chức năng",
      "3.2.2 Khám phá sản phẩm",
      "3.2.2.1 Duyệt trang chủ",
      "3.2.3 Đặc tả use case",
      "3.3 Chất lượng dịch vụ",
      "3.3.1 Hiệu năng",
      "3.3.5 Khả năng quan sát",
      "3.3.6 Tính khả dụng",
      "Mục tiêu"
    ])
  })

  it("trả bảng chữ cũ ⇒ chữ mới chỉ cho heading đổi số", () => {
    const { changed } = renumberEntries(entries, "text")
    expect(changed.get("3.2 Tài khoản và truy cập")).toBe("3.2.1 Tài khoản và truy cập")
    expect(changed.has("3.2 Chức năng")).toBe(false)
    expect(changed.has("Mục tiêu")).toBe(false)
  })

  it("chữ cũ trùng nhau mà đổi thành hai số khác nhau ⇒ không đưa vào bảng (không sửa tham chiếu mơ hồ)", () => {
    const { changed } = renumberEntries([t("1. A", 1), o("9.1 Ghi chú", 2), t("2. B", 1), o("9.1 Ghi chú", 2)], "text")
    expect(changed.has("9.1 Ghi chú")).toBe(false)
  })

  it("heading cha không có số ⇒ heading con giữ nguyên", () => {
    expect(renumberEntries([t("Phụ lục", 1), o("5.3 Danh sách thông báo", 2, "moved")], "text").texts).toEqual(["Phụ lục", "5.3 Danh sách thông báo"])
  })
})

describe("renumberEntries — kiểu khác", () => {
  it("auto: bỏ số chữ cũ của heading không thuộc mẫu (Word tự đánh)", () => {
    const { texts, changed } = renumberEntries([t("Functions", 1), o("3.2 Login", 2), o("Notes", 2)], "auto")
    expect(texts).toEqual(["Functions", "Login", "Notes"])
    expect(changed.get("3.2 Login")).toBe("Login")
  })

  it("none: giữ nguyên", () => {
    expect(renumberEntries([t("Functions", 1), o("3.2 Login", 2)], "none").texts).toEqual(["Functions", "3.2 Login"])
  })
})
