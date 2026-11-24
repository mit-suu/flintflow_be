import { describe, expect, it } from "vitest"
import { findQuoteSource, normalizeQuoteText, verifyQuote } from "./quote-check.js"

const BRIEF = "Khách đặt bàn trước và thanh toán online qua ví điện tử.\nNhân viên  xác nhận đơn trong 5 phút."
const DOCUMENT = "[D1-P03] The manager approves refunds above 2,000,000 VND."

describe("verifyQuote - câu trích phải là chuỗi con của một nguồn (FLF-449 N2)", () => {
  it("chuỗi con nguyên văn ⇒ đạt", () => {
    expect(verifyQuote("thanh toán online qua ví điện tử", [BRIEF])).toBe(true)
    expect(verifyQuote("The manager approves refunds above 2,000,000 VND", [BRIEF, DOCUMENT])).toBe(true)
  })

  it("khác khoảng trắng, xuống dòng, hoa thường ⇒ vẫn đạt", () => {
    expect(verifyQuote("ví điện tử. nhân viên xác nhận ĐƠN", [BRIEF])).toBe(true)
    expect(verifyQuote("  the MANAGER   approves refunds ", [DOCUMENT])).toBe(true)
  })

  it("dấu nháy cong / thẳng, gạch dài, dấu chấm cuối thêm bớt ⇒ vẫn đạt", () => {
    expect(verifyQuote("“thanh toán online”.", [BRIEF])).toBe(true)
    expect(verifyQuote("it's 5–10 minutes", ["It’s 5-10 minutes at most"])).toBe(true)
  })

  it("tiếng Việt dạng tổ hợp (NFD) so với dạng dựng sẵn (NFC) ⇒ đạt", () => {
    expect(verifyQuote("thanh toán online".normalize("NFD"), [BRIEF])).toBe(true)
  })

  it("dấu ba chấm: từng phần có mặt đúng thứ tự trong cùng nguồn", () => {
    expect(verifyQuote("Khách đặt bàn trước … ví điện tử", [BRIEF])).toBe(true)
    expect(verifyQuote("ví điện tử ... Khách đặt bàn", [BRIEF]), "sai thứ tự").toBe(false)
    expect(verifyQuote("Khách đặt bàn ... approves refunds", [BRIEF, DOCUMENT]), "hai phần ở hai nguồn").toBe(false)
  })

  it("câu bịa hoặc diễn lại ⇒ không đạt", () => {
    expect(verifyQuote("thanh toán bằng thẻ tín dụng", [BRIEF, DOCUMENT])).toBe(false)
    expect(verifyQuote("customers pay online with an e-wallet", [BRIEF])).toBe(false)
  })

  it("câu trích rỗng, quá ngắn, không phải chuỗi ⇒ không đạt", () => {
    expect(verifyQuote("", [BRIEF])).toBe(false)
    expect(verifyQuote("   ", [BRIEF])).toBe(false)
    expect(verifyQuote("a", [BRIEF])).toBe(false)
    expect(verifyQuote(null, [BRIEF])).toBe(false)
    expect(verifyQuote(undefined, [BRIEF])).toBe(false)
  })

  it("nguồn rỗng / null bị bỏ qua; không có nguồn ⇒ không đạt", () => {
    expect(verifyQuote("thanh toán online", [null, undefined, "", BRIEF])).toBe(true)
    expect(verifyQuote("thanh toán online", [])).toBe(false)
  })

  it("findQuoteSource trả vị trí nguồn chứa câu trích", () => {
    expect(findQuoteSource("approves refunds", [BRIEF, DOCUMENT])).toBe(1)
    expect(findQuoteSource("không có ở đâu", [BRIEF, DOCUMENT])).toBe(-1)
  })

  it("normalizeQuoteText gộp khoảng trắng, hạ chữ thường, đổi nháy cong", () => {
    expect(normalizeQuoteText("  A\n\t“B”  ‘c’ ")).toBe("a \"b\" 'c'")
  })
})
