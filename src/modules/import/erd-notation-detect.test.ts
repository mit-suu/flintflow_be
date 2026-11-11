import { describe, expect, it } from "vitest"
import { erdNotationInText, erdNotationOfDocument } from "./erd-notation-detect.js"

describe("bug #12b (QLHS 11/11): ký pháp ERD theo file upload", () => {
  it("nhận chân chim / crow's foot / IDEF1X / Chen (Chen chỉ khi nói về ký pháp hay ERD)", () => {
    expect(erdNotationInText("H7 | ERD (ký hiệu chân chim) | 12 thực thể và quan hệ | 3.7.1")).toBe("crowsfoot")
    expect(erdNotationInText("Ký hiệu: vạch ngang = phía 1, Chân chim = phía nhiều")).toBe("crowsfoot")
    expect(erdNotationInText("Figure 4: ERD in Crow's Foot notation")).toBe("crowsfoot")
    expect(erdNotationInText("crowsfoot")).toBe("crowsfoot")
    expect(erdNotationInText("Mô hình dữ liệu theo chuẩn IDEF1X")).toBe("idef1x")
    expect(erdNotationInText("ERD vẽ theo ký pháp Chen")).toBe("chen")
    expect(erdNotationInText("Người phụ trách: Chen Wei")).toBeNull()
    expect(erdNotationInText("Sơ đồ thực thể – quan hệ của hệ thống")).toBeNull()
  })

  it("lần nhắc đầu tiên theo thứ tự file, đọc cả từng dòng bảng; không nhắc ⇒ null (giữ mặc định)", () => {
    const catalogue = {
      text: "",
      rows: [
        ["Mã hình", "Tên", "Nội dung", "Mục"],
        ["H6", "Triển khai", "Máy chủ, CSDL", "3.5.3"],
        ["H7", "ERD (ký hiệu chân chim)", "12 thực thể và quan hệ", "3.7.1"]
      ]
    }
    expect(erdNotationOfDocument([{ text: "Giới thiệu" }, catalogue, { text: "ERD theo IDEF1X" }])).toBe("crowsfoot")
    expect(erdNotationOfDocument([{ text: "Giới thiệu" }, { text: "3.7.1 Thực thể và quan hệ", rows: null }])).toBeNull()
  })
})
