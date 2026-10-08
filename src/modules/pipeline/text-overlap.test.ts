import { describe, expect, it } from "vitest"
import { contentWords, normalise, overlapRatio, sentencesOf } from "./text-overlap.js"

describe("text-overlap", () => {
  it("normalise bỏ dấu, hạ thường, đổi đ ⇒ d", () => {
    expect(normalise("Bệnh Nhân Đặt lịch")).toBe("benh nhan dat lich")
  })

  it("contentWords bỏ từ chức năng và trùng lặp", () => {
    expect([...contentWords("Tôi tạm hiểu là bệnh nhân và bệnh nhân dùng app")]).toEqual(["benh", "nhan", "dung", "app"])
  })

  it("overlapRatio: câu diễn lại kèm chi tiết thêm ⇒ cao (mẫu số là câu ngắn); câu khác nội dung ⇒ thấp", () => {
    const short = "Giờ cao điểm có khoảng 200 bệnh nhân dùng app/web cùng lúc."
    const long = "Giờ cao điểm có khoảng 200 người dùng app/web cùng lúc, ngoài 800–1.000 lượt khám mỗi ngày."
    expect(overlapRatio(short, long)).toBeGreaterThanOrEqual(0.8)
    expect(overlapRatio(long, short)).toBe(overlapRatio(short, long))
    const other = "Thông báo gọi bệnh nhân kế tiếp gửi qua ứng dụng điện thoại kèm SMS."
    expect(overlapRatio(short, other)).toBeLessThan(0.5)
  })

  it("overlapRatio: rỗng hoặc chỉ từ chức năng ⇒ 0", () => {
    expect(overlapRatio("", "abc")).toBe(0)
    expect(overlapRatio("tôi và bạn", "tôi và bạn")).toBe(0)
  })

  it("sentencesOf tách theo dấu kết câu, giữ dấu", () => {
    expect(sentencesOf("Xong rồi. Bạn ổn chứ? Đi tiếp nhé…")).toEqual(["Xong rồi.", "Bạn ổn chứ?", "Đi tiếp nhé…"])
  })
})
