import { describe, it, expect } from "vitest"
import { blockText, resolveAnchor } from "./comment.anchor.js"
import type { RenderedDocument } from "../render/rendered-document.types.js"

const doc = {
  sections: [
    {
      id: "feature:F2",
      number: "3.2.4",
      heading: "Cancel booking",
      level: 3,
      blocks: [
        { type: "paragraph", runs: [{ text: "The customer " }, { text: "cancels", bold: true }, { text: " a booking." }] },
        { type: "table", header: [[{ text: "Step" }], [{ text: "Action" }]], rows: [[[{ text: "1" }], [{ text: "Open list" }]]] },
        { type: "paragraph", runs: [{ text: "x".repeat(400) }] }
      ]
    },
    { id: "group:3", number: "3", heading: "Functional Requirements", level: 1, blocks: [] }
  ]
} as unknown as RenderedDocument

describe("resolveAnchor", () => {
  it("ghim một block ⇒ nhãn `<số> <tiêu đề> › Block n` và đoạn trích chữ thuần", () => {
    expect(resolveAnchor(doc, "feature:F2", 0)).toEqual({
      section_id: "feature:F2",
      block_index: 0,
      label: "3.2.4 Cancel booking › Block 1",
      excerpt: "The customer cancels a booking."
    })
    expect(resolveAnchor(doc, "feature:F2", 1)?.excerpt).toBe("Step | Action / 1 | Open list")
  })

  it("ghim cả section ⇒ nhãn chỉ là tiêu đề; đoạn trích dài bị cắt ở 160 ký tự", () => {
    const anchor = resolveAnchor(doc, "feature:F2", null)
    expect(anchor?.label).toBe("3.2.4 Cancel booking")
    expect(anchor?.excerpt).toHaveLength(160)
    expect(anchor?.excerpt?.endsWith("…")).toBe(true)
  })

  it("section rỗng ⇒ excerpt null; section / block không tồn tại ⇒ null", () => {
    expect(resolveAnchor(doc, "group:3", null)?.excerpt).toBeNull()
    expect(resolveAnchor(doc, "fixed:9", null)).toBeNull()
    expect(resolveAnchor(doc, "feature:F2", 3)).toBeNull()
  })
})

describe("blockText", () => {
  it("danh sách nối bằng ·, ảnh lấy chú thích, ngắt trang rỗng", () => {
    expect(blockText({ type: "bullet_list", items: [[{ text: "a" }], [{ text: "b" }]] })).toBe("a · b")
    expect(blockText({ type: "image", png: "", caption: "Figure 1" })).toBe("Figure 1")
    expect(blockText({ type: "page_break" })).toBe("")
  })
})
