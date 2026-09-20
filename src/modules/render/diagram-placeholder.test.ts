import { describe, it, expect } from "vitest"
import { imageSize } from "image-size"
import { buildPlaceholderPng, DIAGRAM_PLACEHOLDER_HEIGHT, DIAGRAM_PLACEHOLDER_PNG, DIAGRAM_PLACEHOLDER_WIDTH, pendingImageCaption } from "./diagram-placeholder.js"

describe("diagram-placeholder", () => {
  it("là PNG hợp lệ đúng kích thước — image-size (writer .docx) đọc được", () => {
    const size = imageSize(Buffer.from(DIAGRAM_PLACEHOLDER_PNG, "base64"))
    expect(size).toMatchObject({ type: "png", width: DIAGRAM_PLACEHOLDER_WIDTH, height: DIAGRAM_PLACEHOLDER_HEIGHT })
  })

  it("buildPlaceholderPng tất định và nhỏ (một màu nén tốt)", () => {
    const a = buildPlaceholderPng(64, 8)
    expect(a.equals(buildPlaceholderPng(64, 8))).toBe(true)
    expect(imageSize(a)).toMatchObject({ type: "png", width: 64, height: 8 })
    expect(Buffer.from(DIAGRAM_PLACEHOLDER_PNG, "base64").length).toBeLessThan(2048)
  })

  it("caption nêu rõ sơ đồ chưa render, giữ caption gốc nếu có", () => {
    expect(pendingImageCaption("Use Case Diagram", "D02")).toBe("Use Case Diagram — image pending: diagram D02 has not been rendered yet")
    expect(pendingImageCaption(undefined, "D02")).toBe("image pending: diagram D02 has not been rendered yet")
  })
})
