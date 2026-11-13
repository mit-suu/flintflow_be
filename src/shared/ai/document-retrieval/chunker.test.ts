import { describe, expect, it } from "vitest"
import { splitParagraphs } from "../document-paragraphs.js"
import { CHUNK_TARGET_TOKENS, chunkParagraphs, detectHeading, estimateDocTokens } from "./chunker.js"

const body = (seed: string, sentences: number): string => Array.from({ length: sentences }, (_, i) => `${seed} câu số ${i + 1} mô tả chi tiết nghiệp vụ của hệ thống.`).join(" ")

describe("detectHeading (FLF-393)", () => {
  it("số mục nhiều cấp, markdown, từ khoá, mã", () => {
    expect(detectHeading("3.2.1 Đăng ký tài khoản")).toEqual({ level: 3, title: "3.2.1 Đăng ký tài khoản" })
    expect(detectHeading("## Use Cases")).toEqual({ level: 2, title: "Use Cases" })
    expect(detectHeading("Chương 2 Yêu cầu người dùng")?.level).toBe(1)
    expect(detectHeading("UC-05 Đặt lịch khám")?.level).toBe(9)
  })

  it("số một cấp chỉ nhận khi nối tiếp mục trước — danh sách đánh số không thành heading", () => {
    expect(detectHeading("1. Giới thiệu", 0)?.level).toBe(1)
    expect(detectHeading("2 Yêu cầu người dùng", 1)?.level).toBe(1)
    expect(detectHeading("1. Người dùng mở trang đăng nhập", 3)).toBeNull()
  })

  it("câu thường, đoạn nhiều dòng, dòng quá dài không phải heading", () => {
    expect(detectHeading("3.2 Hệ thống gửi email xác nhận cho khách hàng.")).toBeNull()
    expect(detectHeading("UC-05 cho phép khách hàng đặt lịch khám.")).toBeNull()
    expect(detectHeading("2.1 Actors\nDanh sách tác nhân")).toBeNull()
    expect(detectHeading(`2.1 ${"x".repeat(200)}`)).toBeNull()
  })
})

describe("chunkParagraphs (FLF-393)", () => {
  const text = [
    "Tài liệu đặc tả",
    "1 Giới thiệu",
    body("Giới thiệu", 30),
    "2 Yêu cầu người dùng",
    "2.1 Actors",
    body("Tác nhân", 30),
    "2.2 Use Cases",
    "UC-01 Đăng nhập",
    body("Đăng nhập", 30),
    "UC-02 Đặt lịch",
    body("Đặt lịch", 30)
  ].join("\n\n")
  const paragraphs = splitParagraphs(text)
  const chunks = chunkParagraphs(paragraphs)

  it("phủ kín mọi đoạn, không chồng, đúng thứ tự — mã đoạn tra ngược được", () => {
    expect(chunks[0]!.p_start).toBe(0)
    expect(chunks[chunks.length - 1]!.p_end).toBe(paragraphs.length - 1)
    chunks.forEach((c, i) => {
      expect(c.ordinal).toBe(i)
      expect(c.paragraphs).toEqual(paragraphs.slice(c.p_start, c.p_end + 1))
      if (i > 0) expect(c.p_start).toBe(chunks[i - 1]!.p_end + 1)
    })
  })

  it("đường dẫn mục theo cây heading; heading mã nằm dưới mục đang mở", () => {
    const login = chunks.find((c) => c.paragraphs.some((p) => p.startsWith("Đăng nhập câu số 1")))!
    expect(login.heading_path).toEqual(["2 Yêu cầu người dùng", "2.2 Use Cases", "UC-01 Đăng nhập"])
    const actors = chunks.find((c) => c.paragraphs.some((p) => p.startsWith("Tác nhân câu số 1")))!
    expect(actors.heading_path).toEqual(["2 Yêu cầu người dùng", "2.1 Actors"])
    // UC-02 thay UC-01 (cùng cấp lá), không lồng vào nhau
    const booking = chunks.find((c) => c.paragraphs.some((p) => p.startsWith("Đặt lịch câu số 1")))!
    expect(booking.heading_path).toEqual(["2 Yêu cầu người dùng", "2.2 Use Cases", "UC-02 Đặt lịch"])
  })

  it("mục chỉ có tiêu đề được gộp vào mục con liền sau, giữ tiêu đề để ghim", () => {
    const actors = chunks.find((c) => c.titles.includes("2.1 Actors"))!
    expect(actors.paragraphs[0]).toBe("2 Yêu cầu người dùng")
    expect(actors.titles).toEqual(expect.arrayContaining(["2 Yêu cầu người dùng", "2.1 Actors"]))
  })

  it("mục dài bị cắt theo đoạn, mỗi chunk không quá cỡ đích (trừ đoạn đơn quá dài)", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Đoạn ${i + 1}: ${body("Nội dung", 4)}`).join("\n\n")
    const parts = chunkParagraphs(splitParagraphs(`1 Mục dài\n\n${long}`))
    expect(parts.length).toBeGreaterThan(3)
    for (const c of parts) {
      expect(c.heading_path).toEqual(["1 Mục dài"])
      if (c.paragraphs.length > 1) expect(c.tokens).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS)
    }
  })

  it("tài liệu không có heading vẫn cắt theo cỡ", () => {
    const flat = Array.from({ length: 30 }, (_, i) => `Ý ${i + 1}. ${body("Biên bản", 5)}`).join("\n\n")
    const parts = chunkParagraphs(splitParagraphs(flat))
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((c) => c.heading_path.length === 0)).toBe(true)
  })

  it("có outline thì theo outline: dòng ngắn không số vẫn là heading, số trong chữ không tự thành heading", () => {
    const ps = ["Use Case Descriptions", body("Mô tả", 3), "1. Người dùng mở trang", "Screen Flow", body("Luồng", 3)]
    const withOutline = chunkParagraphs(ps, [
      { p: 0, level: 1 },
      { p: 3, level: 1 }
    ])
    expect(withOutline.map((c) => c.heading_path)).toEqual([["Use Case Descriptions"], ["Screen Flow"]])
    expect(chunkParagraphs(ps).every((c) => !c.titles.includes("Screen Flow"))).toBe(true)
  })

  it("rỗng ⇒ không chunk; ước lượng token thận trọng (ký tự / 3)", () => {
    expect(chunkParagraphs([])).toEqual([])
    expect(estimateDocTokens("a".repeat(30))).toBe(10)
  })
})
