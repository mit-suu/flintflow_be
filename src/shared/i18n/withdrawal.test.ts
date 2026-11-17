import { describe, expect, it } from "vitest"
import { isWithdrawal } from "./withdrawal.js"

describe("isWithdrawal", () => {
  it("mở đầu bằng lời dừng (như trước)", () => {
    for (const t of ["thôi không cần thêm nữa", "Bỏ qua", "huỷ yêu cầu", "never mind", "Không cần nữa", "thôi khỏi"]) expect(isWithdrawal(t), t).toBe(true)
  })

  it("FLF-439: cả câu là lời thôi đổi có dấu hiệu dừng", () => {
    for (const t of [
      "không đổi nữa",
      "Không đổi nữa.",
      "ko sửa gì nữa đâu",
      "khong doi nua",
      "vậy không thêm nữa nhé",
      "không xoá nữa",
      "khỏi",
      "khỏi sửa nữa nha",
      "No more changes",
      "drop it",
      "forget about it",
      "don't change anything"
    ])
      expect(isWithdrawal(t), t).toBe(true)
  })

  it("câu trả lời thật hoặc lệnh sửa không tính", () => {
    for (const t of [
      "Thêm use case X",
      "đổi tên A01 thành Product Owner",
      "chỉ thao tác xóa",
      // trả lời "có / không" cho câu hỏi làm rõ
      "không đổi",
      "không đổi tên, chỉ đổi mô tả",
      "không đổi nữa mà thêm màn Báo cáo",
      "giữ nguyên",
      "Giữ như cũ, không áp dụng phần này của CR",
      "để như cũ",
      "khỏi phải hỏi, dùng màn Quản lý lớp",
      "leave it as is"
    ])
      expect(isWithdrawal(t), t).toBe(false)
  })
})
