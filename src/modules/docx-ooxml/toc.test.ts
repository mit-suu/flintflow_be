import { describe, expect, it } from "vitest"
import { TocIndex, isHandTocLine, parseTocLine, tocKey } from "./toc.js"

describe("toc (FLF-343)", () => {
  it("parseTocLine: bỏ số trang + chuỗi dẫn, tách số mục, cấp theo style rồi theo số", () => {
    expect(parseTocLine("3.2.1 Register account ......... 12")).toEqual({ number: "3.2.1", title: "Register account", level: 3 })
    expect(parseTocLine("1.1\tPurpose\t4", 2)).toEqual({ number: "1.1", title: "Purpose", level: 2 })
    expect(parseTocLine("Introduction\t3")).toEqual({ number: null, title: "Introduction", level: 1 })
    expect(parseTocLine("....... 3")).toBeNull()
  })

  it("isHandTocLine: tiêu đề + dẫn chấm / tab + số trang; câu văn có số cuối thì không", () => {
    expect(isHandTocLine("2.1 Actors ........ 5")).toBe(true)
    expect(isHandTocLine("Giới thiệu …… 3")).toBe(true)
    expect(isHandTocLine("The system shall respond within 2")).toBe(false)
    expect(isHandTocLine("12 ........ 3")).toBe(false)
  })

  it("TocIndex.find: đoạn gõ số phải trùng cả tiêu đề lẫn số; đoạn không số chỉ khớp khi được phép; mỗi mục dùng một lần", () => {
    const toc = new TocIndex([parseTocLine("2.1 Tác nhân ..... 5")!, parseTocLine("3.1 Overview ..... 7")!])
    expect(tocKey("2.1  Tác Nhân.")).toBe("tac nhan")
    // câu thân bài trùng tiêu đề mục lục, không số ⇒ không khớp nếu người gọi không cho phép
    expect(toc.find("Overview")).toBeNull()
    expect(toc.find("4.1 Overview")).toBeNull()
    expect(toc.find("Something else")).toBeNull()
    expect(toc.find("Tác nhân", { unnumbered: true })?.number).toBe("2.1")
    expect(toc.find("3.1 Overview")?.level).toBe(2)
    // đã dùng ⇒ không khớp lần hai
    expect(toc.find("3.1 Overview")).toBeNull()
    expect(toc.size).toBe(2)
  })
})
