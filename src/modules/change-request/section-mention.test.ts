import { describe, expect, it } from "vitest"
import { mentionedSections, type HeadingRef } from "./section-mention.js"

/** Tài liệu người dùng: số mục lệch mẫu FPT — "3.1.3" của họ là ERD (FPT 3.1.5). */
const HEADINGS: HeadingRef[] = [
  { text: "3.1.2 Mô tả màn hình", section_id: "fixed:3.1.2" },
  { text: "3.1.3 Sơ đồ quan hệ thực thể", section_id: "fixed:3.1.5" },
  { text: "4.2 Yêu cầu phi chức năng", section_id: "group:4.2" },
  { text: "5.9 Team Notes", section_id: "custom:CS02" }
]

describe("mentionedSections — mục người yêu cầu gọi tên", () => {
  it("CR-008: \"phần 3.1.3 Screen Authorization\" ⇒ mục FPT theo TÊN (không theo số 3.1.3 của tài liệu = ERD)", () => {
    expect(mentionedSections("tạo bảng cho phần 3.1.3 Screen Authorization", HEADINGS)).toEqual(["fixed:3.1.3"])
    expect(mentionedSections("phần bạn tạo ở NFR-07 là phải ở 3.1.3  Phân quyền màn hình", HEADINGS)).toEqual(["fixed:3.1.3"])
  })

  it("tên theo tiêu đề của chính tài liệu (kể cả markdown ####)", () => {
    expect(mentionedSections("tạo bảng #### 3.1.3 Sơ đồ quan hệ thực thể", HEADINGS)).toEqual(["fixed:3.1.5"])
    expect(mentionedSections("Thêm ghi chú vào mục Team Notes", HEADINGS)).toEqual(["custom:CS02"])
  })

  it("chỉ số mục sau \"mục/phần\" ⇒ tiêu đề tài liệu mang số đó trước, không có thì mục FPT cùng số", () => {
    expect(mentionedSections("sửa lại phần 3.1.3 cho đúng", HEADINGS)).toEqual(["fixed:3.1.5"])
    expect(mentionedSections("bổ sung mục 5.1", HEADINGS)).toEqual(["fixed:5.1"])
  })

  it("không gọi mục ⇒ không đoán: tên mục chen trong câu, số đo, mục nhóm", () => {
    expect(mentionedSections("sửa mô tả use case UC-02 cho rõ", HEADINGS)).toEqual([])
    expect(mentionedSections("thời gian phản hồi 4.2 giây", HEADINGS)).toEqual([])
    expect(mentionedSections("phần 4.2 Yêu cầu phi chức năng", HEADINGS)).toEqual([])
  })
})
