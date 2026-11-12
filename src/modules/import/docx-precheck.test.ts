import { describe, expect, it } from "vitest"
import { makeDocx, p, styled, table } from "../docx-ooxml/testing/make-docx.js"
import { headingOverlap, looksLikeSrs, srsSuggestion } from "./docx-precheck.js"
import { preflightDocx } from "./preflight.service.js"
import type { DocumentKind } from "./srs-detect.js"
import { makeIeeeSrsDocx, makeSrsDocx } from "./testing/srs-fixture.js"

const kind = (k: DocumentKind, signals: string[] = []) => ({ kind: k, confidence: 0.8, signals, reasons: [] })
const h1 = (t: string) => styled("u1", t)
const h2 = (t: string) => styled("u2", t)
const suggestionOf = async (docx: Buffer) => srsSuggestion(await preflightDocx(docx))

describe("srsSuggestion (FLF-409)", () => {
  it("dấu version ⇒ strong; không phải SRS / chưa chắc ⇒ none", () => {
    expect(srsSuggestion({ stamp: { project_id: "p1" } as never, document_kind: null })).toBe("strong")
    expect(srsSuggestion({ stamp: null, document_kind: kind("not_srs") })).toBe("none")
    expect(srsSuggestion({ stamp: null, document_kind: kind("unknown") })).toBe("none")
    expect(srsSuggestion({ stamp: null, document_kind: null })).toBe("none")
  })

  it("srs chỉ có tín hiệu nội dung (từ khoá, mã UC, bảng) ⇒ possible, không phải strong", () => {
    expect(srsSuggestion({ stamp: null, document_kind: kind("srs", ["keyword:use_case", "keyword:actor", "id:UC-01,UC-02,UC-03", "table:1"]) })).toBe("possible")
  })

  it("tiêu đề SRS hoặc mẫu SRS trống ⇒ strong", () => {
    expect(srsSuggestion({ stamp: null, document_kind: kind("srs", ["title:srs"]) })).toBe("strong")
    expect(srsSuggestion({ stamp: null, document_kind: kind("srs_template") })).toBe("strong")
  })

  it("có dấu hiệu loại tài liệu khác mà không có tiêu đề SRS ⇒ none; có tiêu đề SRS thì tiêu đề thắng", () => {
    const form = ["chapter:1", "chapter:3", "chapter:4", "form:levels", "form:revision"]
    expect(srsSuggestion({ stamp: null, document_kind: kind("srs", [...form, "against:meeting"]) })).toBe("none")
    expect(srsSuggestion({ stamp: null, document_kind: kind("srs", ["title:srs", "against:meeting"]) })).toBe("strong")
  })

  it("điểm hình thức: ≥ 3 ⇒ strong, dưới 3 ⇒ possible", () => {
    expect(srsSuggestion({ stamp: null, document_kind: kind("srs", ["chapter:1", "chapter:3", "chapter:4", "form:levels"]) })).toBe("strong")
    expect(srsSuggestion({ stamp: null, document_kind: kind("srs", ["chapter:3", "chapter:4", "form:levels", "form:revision"]) })).toBe("strong")
    expect(srsSuggestion({ stamp: null, document_kind: kind("srs", ["chapter:3", "chapter:4", "form:levels"]) })).toBe("possible")
    expect(srsSuggestion({ stamp: null, document_kind: kind("srs", ["chapter:3", "form:toc"]) })).toBe("possible")
  })

  it("looksLikeSrs = chỉ gợi ý mạnh", () => {
    expect(looksLikeSrs({ stamp: null, document_kind: kind("srs", ["title:srs"]) })).toBe(true)
    expect(looksLikeSrs({ stamp: null, document_kind: kind("srs", ["keyword:use_case"]) })).toBe(false)
  })
})

describe("srsSuggestion trên file thật (spec Phụ lục A)", () => {
  it("A1 bảng Use Case: tiêu đề + 2 đoạn + 1 bảng ⇒ possible", async () => {
    const rows = [["ID", "Use Case", "Actor", "Mô tả ngắn"], ...Array.from({ length: 8 }, (_, i) => [`UC${String(i + 1).padStart(2, "0")}`, `Chức năng ${i + 1}`, "User", "Người dùng thao tác trên màn hình"])]
    const docx = await makeDocx({
      body: [p("BẢNG USE CASE - FLINTFLOW"), p("Phân bổ theo vai trò chịu trách nhiệm chính."), p("Actor chính: Guest · User · Admin"), table(rows)].join("")
    })
    expect(await suggestionOf(docx)).toBe("possible")
  })

  it("A4 biên bản họp có heading yêu cầu ⇒ none", async () => {
    const docx = await makeDocx({
      body: [
        p("BIÊN BẢN HỌP CHỐT YÊU CẦU"),
        p("Thành phần tham dự: anh Nam (PO), chị Lan (BA), anh Hùng (Dev)."),
        h1("1. Functional Requirements"),
        p("UC-01 Đăng nhập, UC-02 Đặt hàng, UC-03 Thanh toán - actor là khách hàng."),
        h1("2. Non-Functional Requirements"),
        p("Hiệu năng: phản hồi dưới 2 giây; bảo mật theo chuẩn của công ty."),
        h1("3. Business Rules"),
        p("BR-01: đơn trên 5 triệu cần duyệt."),
        h1("4. Action items"),
        p("Biên bản họp gửi lại các bên trước thứ Sáu.")
      ].join("")
    })
    expect(await suggestionOf(docx)).toBe("none")
  })

  it("SRS mẫu FPT và mẫu IEEE ⇒ strong", async () => {
    expect(await suggestionOf(await makeSrsDocx())).toBe("strong")
    expect(await suggestionOf(await makeIeeeSrsDocx())).toBe("strong")
  })

  it("mẫu khách không có phần mở đầu nhưng có lịch sử thay đổi + heading nhiều cấp ⇒ strong", async () => {
    const docx = await makeDocx({
      body: [
        p("Hệ thống quản lý kho"),
        table([["Version", "Date", "Author", "Change"], ["1.0", "01/11/2026", "Lan", "Bản đầu"]]),
        h1("1 Functional Requirements"),
        h2("1.1 Use Cases"),
        p("UC-01 Nhập kho, UC-02 Xuất kho, UC-03 Kiểm kê - actor là thủ kho."),
        h2("1.2 Business Rules"),
        p("BR-01: không xuất quá tồn."),
        h1("2 Non-Functional Requirements"),
        h2("2.1 Performance"),
        p("Phản hồi dưới 2 giây."),
        h2("2.2 Security"),
        p("Đăng nhập bằng tài khoản công ty.")
      ].join("")
    })
    expect(await suggestionOf(docx)).toBe("strong")
  })
})

describe("headingOverlap", () => {
  it("tỉ lệ heading của file có trong SRS của dự án - bỏ số mục, không phân biệt hoa thường, đếm mỗi heading một lần", () => {
    const project = ["1 Product Overview", "2.1 Actors", "2.2 Use Cases", "3.1 Screen Flow"]
    expect(headingOverlap(["1. product overview", "2.1 Actors", "9 Budget", "9 Budget"], project)).toBe(0.67)
    expect(headingOverlap(["Meeting notes"], project)).toBe(0)
    expect(headingOverlap([], project)).toBe(0)
  })
})
