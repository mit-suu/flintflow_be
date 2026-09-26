import { describe, expect, it } from "vitest"
import { buildPlaceholderPng } from "./diagram-placeholder.js"
import { MEDIA_PREFIX, embeddableImage, isMediaId, mediaId } from "./import-media.js"

describe("import-media (mode 1 v3 phase 5, T3)", () => {
  it("mediaId / isMediaId: tiền tố media: tách khỏi id diagram", () => {
    expect(mediaId("word/media/image1.png")).toBe(`${MEDIA_PREFIX}word/media/image1.png`)
    expect(isMediaId(mediaId("x"))).toBe(true)
    expect(isMediaId("D01")).toBe(false)
  })

  it("embeddableImage: PNG, JPEG ⇒ true; EMF, rỗng ⇒ false", () => {
    expect(embeddableImage(buildPlaceholderPng(4, 4))).toBe(true)
    expect(embeddableImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(true)
    expect(embeddableImage(Buffer.from([0x01, 0, 0, 0, 0x6c, 0, 0, 0, 0, 0]))).toBe(false)
    expect(embeddableImage(Buffer.alloc(0))).toBe(false)
  })
})
