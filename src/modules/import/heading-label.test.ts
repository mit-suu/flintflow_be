import { describe, expect, it } from "vitest"
import { plainHeading } from "./heading-label.js"

describe("plainHeading (FLF-362)", () => {
  it("bỏ số mục gõ tay ở đầu tiêu đề; tiêu đề không số giữ nguyên", () => {
    expect(plainHeading("1. Giới thiệu")).toBe("Giới thiệu")
    expect(plainHeading("1.3 Định nghĩa, từ viết tắt")).toBe("Định nghĩa, từ viết tắt")
    expect(plainHeading("3.2.1 UC-01 Đăng nhập và phân quyền")).toBe("UC-01 Đăng nhập và phân quyền")
    expect(plainHeading("II. Software Requirement Specification")).toBe("Software Requirement Specification")
    expect(plainHeading("  Lịch sử sửa đổi ")).toBe("Lịch sử sửa đổi")
  })
})
