import { describe, expect, it } from "vitest"
import { buildBm25, searchBm25 } from "./bm25.js"
import { tokenize } from "./vi-tokenizer.js"

const DOCS = [
  { id: "c1", text: "UC-12 Đăng nhập: khách hàng nhập email và mật khẩu để đăng nhập hệ thống." },
  { id: "c2", text: "UC-21 Đăng ký tài khoản: khách hàng nhập email, họ tên, mật khẩu." },
  { id: "c3", text: "Màn hình Đặt lịch hiển thị danh sách bác sĩ và khung giờ còn trống." },
  { id: "c4", text: "Yêu cầu hiệu năng: trang thanh toán phải phản hồi trong 3 giây." }
]

const index = buildBm25(DOCS, tokenize)
const top = (query: string, limit = 2) => searchBm25(index, tokenize(query), limit).map((h) => h.id)

describe("bm25 (FLF-393)", () => {
  it("mã chính xác thắng mã gần giống", () => {
    expect(top("UC-12 làm gì")[0]).toBe("c1")
    expect(top("uc21")[0]).toBe("c2")
  })

  it("tiếng Việt có dấu và không dấu ra cùng đoạn", () => {
    expect(top("màn hình đặt lịch")[0]).toBe("c3")
    expect(top("man hinh dat lich")[0]).toBe("c3")
    expect(top("dang nhap")[0]).toBe("c1")
  })

  it("bigram phân biệt đăng nhập với đăng ký", () => {
    expect(top("đăng ký")[0]).toBe("c2")
    expect(top("đăng nhập")[0]).toBe("c1")
  })

  it("không trùng token nào ⇒ rỗng; limit được tôn trọng", () => {
    expect(top("blockchain")).toEqual([])
    expect(searchBm25(index, tokenize("khách hàng nhập email mật khẩu"), 1)).toHaveLength(1)
  })

  it("tất định: bằng điểm thì theo thứ tự nạp", () => {
    const same = buildBm25(
      [
        { id: "x", text: "thanh toán" },
        { id: "y", text: "thanh toán" }
      ],
      tokenize
    )
    expect(searchBm25(same, tokenize("thanh toán"), 5).map((h) => h.id)).toEqual(["x", "y"])
  })
})
