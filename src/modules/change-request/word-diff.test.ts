import { describe, it, expect } from "vitest"
import { directHit, wordDiff } from "./word-diff.js"

describe("wordDiff", () => {
  it("không đổi ⇒ không đoạn", () => expect(wordDiff("a b c", "a b c")).toEqual([]))
  it("thay / chèn / xoá theo từ", () => {
    expect(wordDiff("Khách đặt hàng", "Người mua đặt hàng")).toEqual([{ start: 0, end: 1, added: ["Người", "mua"] }])
    expect(wordDiff("Khách đặt hàng", "Khách hàng đặt hàng")).toEqual([{ start: 1, end: 1, added: ["hàng"] }])
    expect(wordDiff("Khách đặt hàng online", "Khách đặt hàng")).toEqual([{ start: 3, end: 4, added: [] }])
  })
})

describe("directHit (BF §3.2: yêu cầu gốc đụng thẳng phần vừa sửa ⇒ hỏi lại)", () => {
  it("ví dụ trong BF: 'Khách' → BA2 thành 'Khách hàng', mình thành 'Người mua' ⇒ đụng", () => {
    const hit = directHit("Khách đặt hàng trực tuyến và thanh toán", "Khách hàng đặt hàng trực tuyến và thanh toán", "Người mua đặt hàng trực tuyến và thanh toán")
    expect(hit).toEqual({ original: "Khách", theirs: "Khách hàng", yours: "Người mua" })
  })
  it("người khác sửa chỗ khác trong cùng đoạn ⇒ không đụng (AI áp yêu cầu gốc lên bản hiện tại)", () => {
    expect(directHit("Khách đặt hàng và thanh toán trong 2 giây", "Khách đặt hàng và thanh toán trong 3 giây", "Người mua đặt hàng và thanh toán trong 2 giây")).toBeNull()
  })
  it("cùng đổi một con số ⇒ ba bản của đúng chỗ đó", () => {
    expect(directHit("Ngưỡng phản hồi 2 giây cho 100 người", "Ngưỡng phản hồi 3 giây cho 100 người", "Ngưỡng phản hồi 1 giây cho 100 người")).toEqual({ original: "2", theirs: "3", yours: "1" })
  })
  it("con số lặp ở hai chỗ (phát biểu + chỉ số) ⇒ hỏi gọn theo chỗ đụng đầu tiên, không gộp cả câu", () => {
    expect(directHit("lưu trong vòng 1 giây (p95) — p95 ≤ 1 s", "lưu trong vòng 3 giây (p95) — p95 ≤ 3 s", "lưu trong vòng 2 giây (p95) — p95 ≤ 2 s")).toEqual({ original: "1", theirs: "3", yours: "2" })
  })
})
