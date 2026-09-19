/**
 * Quét mention (I-2 nút 1.5; quét lại theo tên sau I-4) — plan §8.2 `mentions.test.ts`. FLF-172 P4.
 */
import { describe, expect, it } from "vitest"
import { normalizeCode, scanCodeMentions, scanMentions, scanNameMentions, type NamedEntity } from "./mentions.js"

describe("scanCodeMentions — mã yêu cầu", () => {
  it("bắt mã UC/FR/NFR/BR/SCR, chuẩn hoá, không bắt nhầm trong từ khác", () => {
    expect(scanCodeMentions("See UC-01, UC02 and uc-3; FR-2.1, NFR_04, BR 12, SCR-05.")).toEqual([
      { entity: "use_case", id: "UC-01" },
      { entity: "use_case", id: "UC-02" },
      { entity: "function", id: "FR-2.1" },
      { entity: "nfr", id: "NFR-04" },
      { entity: "business_rule", id: "BR-12" },
      { entity: "screen", id: "SCR-05" }
    ])
    expect(scanCodeMentions("ABUC-01 và UC-01X và BRAND-1")).toEqual([])
  })

  it("NFR không bị đọc thành FR, SCR không bị đọc thành SC", () => {
    expect(scanCodeMentions("NFR-01")).toEqual([{ entity: "nfr", id: "NFR-01" }])
    expect(scanCodeMentions("SCR-07")).toEqual([{ entity: "screen", id: "SCR-07" }])
    // SC-xx là cách viết ngắn của mã màn hình
    expect(scanCodeMentions("SC-3")).toEqual([{ entity: "screen", id: "SC-3" }])
  })

  it("mã nằm trong từ/số dài hơn hoặc dính chữ tiếng Việt ⇒ không bắt", () => {
    expect(scanCodeMentions("FRAME-2 SUBR-1 NFR-1a BR-12345 ĐUC-01 UC-01đ")).toEqual([])
    // chữ thường không phải mã (tránh bắt "br", "fr" trong văn xuôi)
    expect(scanCodeMentions("fr-1 br-2 nfr-3")).toEqual([])
  })

  it("mã đứng cạnh dấu câu/ngoặc vẫn bắt", () => {
    expect(scanCodeMentions("(UC-01)/[FR-02]:\"BR-02\"")).toEqual([
      { entity: "use_case", id: "UC-01" },
      { entity: "function", id: "FR-02" },
      { entity: "business_rule", id: "BR-02" }
    ])
  })

  // LỖI SẢN PHẨM (báo cáo P4): CODE_PATTERN chỉ cho một cấp số mục con `(?:\.\d{1,3})?` và lookahead không chặn
  // dấu "." ⇒ "FR-3.2.1" bị đọc thành "FR-3.2". Trong khi I-4 đặt id function theo số mục heading (`FR-3.2.1`,
  // `extracted-entities.ts`), nên mention trong text trỏ nhầm sang id không tồn tại / id của feature cấp trên.
  it.fails("mã function nhiều cấp (FR-3.2.1) giữ đủ số mục như id I-4 sinh ra", () => {
    expect(scanCodeMentions("Xem FR-3.2.1.")).toEqual([{ entity: "function", id: "FR-3.2.1" }])
  })

  it("khử trùng khi một mã lặp lại, thứ tự theo lần xuất hiện đầu", () => {
    expect(scanCodeMentions("UC-02 rồi UC-01 rồi UC-02, UC_02")).toEqual([
      { entity: "use_case", id: "UC-02" },
      { entity: "use_case", id: "UC-01" }
    ])
  })

  it("normalizeCode giữ số như trong tài liệu", () => {
    expect(normalizeCode("uc", "007")).toBe("UC-007")
    expect(normalizeCode("FR", "3.2")).toBe("FR-3.2")
  })
})

describe("scanNameMentions — tên actor/entity sau I-4", () => {
  const names: NamedEntity[] = [
    { entity: "actor", id: "A01", name: "Learner" },
    { entity: "entity", id: "E01", name: "Course" },
    { entity: "actor", id: "A02", name: "PM" }
  ]

  it("bắt theo tên (không phân biệt hoa thường, bỏ tên quá ngắn)", () => {
    expect(scanNameMentions("The learner opens a course list. PM approves.", names)).toEqual([
      { entity: "actor", id: "A01" },
      { entity: "entity", id: "E01" }
    ])
    expect(scanMentions("UC-01 by Learner", names)).toEqual([
      { entity: "use_case", id: "UC-01" },
      { entity: "actor", id: "A01" }
    ])
  })

  it("không bắt nhầm tên nằm trong từ khác", () => {
    expect(scanNameMentions("Learners and Coursework", names)).toEqual([])
    expect(scanNameMentions("UnLearner", names)).toEqual([])
  })

  it("tên tiếng Việt có dấu, tên nhiều từ, ký tự đặc biệt regex", () => {
    const vi: NamedEntity[] = [
      { entity: "actor", id: "A03", name: "Học viên" },
      { entity: "actor", id: "A04", name: "Quản trị viên (Admin)" },
      { entity: "entity", id: "E02", name: "C++ Course" }
    ]
    expect(scanNameMentions("HỌC VIÊN đăng ký khoá học", vi)).toEqual([{ entity: "actor", id: "A03" }])
    expect(scanNameMentions("Học viênx", vi)).toEqual([])
    expect(scanNameMentions("Quản trị viên (Admin) duyệt c++ course", vi)).toEqual([
      { entity: "actor", id: "A04" },
      { entity: "entity", id: "E02" }
    ])
  })

  it("tên chứa tên khác ⇒ cả hai được bắt; tên có khoảng trắng thừa được cắt", () => {
    const nested: NamedEntity[] = [
      { entity: "actor", id: "A05", name: "System Admin" },
      { entity: "actor", id: "A06", name: "  Admin  " }
    ]
    expect(scanNameMentions("The System Admin resets passwords", nested)).toEqual([
      { entity: "actor", id: "A05" },
      { entity: "actor", id: "A06" }
    ])
  })

  it("mã và tên trỏ cùng một thực thể ⇒ khử trùng", () => {
    const screen: NamedEntity[] = [{ entity: "screen", id: "SCR-05", name: "Login screen" }]
    expect(scanMentions("SCR-05 Login screen", screen)).toEqual([{ entity: "screen", id: "SCR-05" }])
  })

  it("không có tên ⇒ chỉ quét mã", () => {
    expect(scanMentions("Learner uses UC-09")).toEqual([{ entity: "use_case", id: "UC-09" }])
  })
})
