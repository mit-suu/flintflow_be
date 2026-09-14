import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { renderedDocumentSchema } from "./rendered-document.schema.js"
import type { RenderedDocument } from "./rendered-document.types.js"

const sample = JSON.parse(
  readFileSync(new URL("../../../fixtures/rendered-document-sample.json", import.meta.url), "utf8")
) as RenderedDocument

describe("renderedDocumentSchema", () => {
  it("fixture mẫu hợp lệ và đủ khung kiểm thử (5 chương, 1 bảng, 1 ảnh, §I 3 dòng, 2 cờ đỏ)", () => {
    const parsed = renderedDocumentSchema.parse(sample)
    const blocks = parsed.sections.flatMap((section) => section.blocks)

    expect(parsed.sections.filter((section) => section.level === 1)).toHaveLength(5)
    expect(blocks.filter((block) => block.type === "table")).toHaveLength(1)
    expect(blocks.filter((block) => block.type === "image")).toHaveLength(1)
    expect(parsed.recordOfChanges).toHaveLength(3)
    expect(parsed.flagsAppendix?.redOpen).toHaveLength(2)
  })

  it("draft thiếu watermark bị từ chối", () => {
    const result = renderedDocumentSchema.safeParse({ ...sample, watermark: undefined })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].path).toEqual(["watermark"])
  })

  it("baseline có watermark bị từ chối", () => {
    const result = renderedDocumentSchema.safeParse({ ...sample, source: "baseline" })
    expect(result.success).toBe(false)
  })

  it("key lạ và block type lạ bị từ chối", () => {
    expect(renderedDocumentSchema.safeParse({ ...sample, extra: 1 }).success).toBe(false)
    const badBlock = {
      ...sample,
      sections: [{ ...sample.sections[0], blocks: [{ type: "video", url: "x" }] }]
    }
    expect(renderedDocumentSchema.safeParse(badBlock).success).toBe(false)
  })

  it("chấp nhận Buffer cho ảnh khi gọi trong process", () => {
    const withBuffer = {
      ...sample,
      sections: [{ ...sample.sections[0], blocks: [{ type: "image", png: Buffer.from([1, 2, 3]) }] }]
    }
    expect(renderedDocumentSchema.safeParse(withBuffer).success).toBe(true)
  })

  it("level ngoài 1–6 bị từ chối", () => {
    const bad = { ...sample, sections: [{ ...sample.sections[0], level: 7 }] }
    expect(renderedDocumentSchema.safeParse(bad).success).toBe(false)
  })
})
