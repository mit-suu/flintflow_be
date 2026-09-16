import { describe, it, expect } from "vitest"
import { markdownToBlocks } from "./markdown-to-blocks.js"

describe("markdownToBlocks — ca biên (review T05)", () => {
  it("đoạn có `|` rồi đường kẻ `---` không bị hiểu thành bảng", () => {
    const blocks = markdownToBlocks("Input | Output mapping\n---\nNext paragraph")
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"])
  })

  it("bảng GFM thật vẫn nhận", () => {
    const blocks = markdownToBlocks("| A | B |\n| --- | --- |\n| 1 | 2 |")
    expect(blocks).toMatchObject([{ type: "table", rows: [[{}, {}]] }])
  })

  it("đoạn bắt đầu bằng năm không phải numbered list; mục 1–3 chữ số vẫn là list", () => {
    expect(markdownToBlocks("2026. The platform launches.")[0].type).toBe("paragraph")
    expect(markdownToBlocks("1. First\n12. Twelfth")[0]).toMatchObject({ type: "numbered_list", items: [[{}], [{}]] })
  })
})
