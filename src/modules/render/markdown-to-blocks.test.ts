import { describe, it, expect } from "vitest"
import { markdownToBlocks, parseInline } from "./markdown-to-blocks.js"

describe("parseInline", () => {
  it("chữ thường là một run", () => {
    expect(parseInline("plain text")).toEqual([{ text: "plain text" }])
  })

  it("bold, italic, code inline", () => {
    expect(parseInline("a **b** *c* `d`")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", code: true }
    ])
  })

  it("lồng italic trong bold và ***x***", () => {
    expect(parseInline("**a *b* c**")).toEqual([
      { text: "a ", bold: true },
      { text: "b", bold: true, italic: true },
      { text: " c", bold: true }
    ])
    expect(parseInline("***x***")).toEqual([{ text: "x", bold: true, italic: true }])
  })

  it("dấu không đóng và escape giữ nguyên dạng chữ", () => {
    expect(parseInline("2 * 3 = 6, **open")).toEqual([{ text: "2 * 3 = 6, **open" }])
    expect(parseInline("\\*not italic\\*")).toEqual([{ text: "*not italic*" }])
  })

  it("không parse markdown bên trong code", () => {
    expect(parseInline("`**raw**`")).toEqual([{ text: "**raw**", code: true }])
  })
})

describe("markdownToBlocks", () => {
  it("heading, đoạn gộp dòng, bullet, numbered", () => {
    const blocks = markdownToBlocks(
      ["# Title", "", "line one", "line two", "", "- a", "* b", "", "1. first", "2) second"].join("\n")
    )
    expect(blocks).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", runs: [{ text: "line one line two" }] },
      { type: "bullet_list", items: [[{ text: "a" }], [{ text: "b" }]] },
      { type: "numbered_list", items: [[{ text: "first" }], [{ text: "second" }]] }
    ])
  })

  it("headingOffset cộng cấp và chặn ở 6", () => {
    const blocks = markdownToBlocks("## Sub\n###### Deep", { headingOffset: 2 })
    expect(blocks).toEqual([
      { type: "heading", level: 4, text: "Sub" },
      { type: "heading", level: 6, text: "Deep" }
    ])
  })

  it("bảng GFM có căn lề, inline trong ô, ô escape |", () => {
    const blocks = markdownToBlocks(
      ["| ID | Name |", "|:---|---:|", "| A1 | **Student** |", "| A2 | a \\| b |", "", "after"].join("\n")
    )
    expect(blocks).toEqual([
      {
        type: "table",
        header: [[{ text: "ID" }], [{ text: "Name" }]],
        rows: [
          [[{ text: "A1" }], [{ text: "Student", bold: true }]],
          [[{ text: "A2" }], [{ text: "a | b" }]]
        ]
      },
      { type: "paragraph", runs: [{ text: "after" }] }
    ])
  })

  it("dòng có | nhưng không có dòng phân cách thì là đoạn", () => {
    expect(markdownToBlocks("a | b")).toEqual([{ type: "paragraph", runs: [{ text: "a | b" }] }])
  })

  it("list ngay sau đoạn tách block, đường kẻ bị bỏ, CRLF được chấp nhận", () => {
    expect(markdownToBlocks("intro\r\n- x\r\n---\r\nend")).toEqual([
      { type: "paragraph", runs: [{ text: "intro" }] },
      { type: "bullet_list", items: [[{ text: "x" }]] },
      { type: "paragraph", runs: [{ text: "end" }] }
    ])
  })

  it("chuỗi rỗng ra mảng rỗng", () => {
    expect(markdownToBlocks("  \n\n")).toEqual([])
  })
})
