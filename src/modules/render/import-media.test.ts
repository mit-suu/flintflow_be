import JSZip from "jszip"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildPlaceholderPng } from "./diagram-placeholder.js"
import { MEDIA_PREFIX, clearImportMediaCache, embeddableImage, embeddableMediaPart, isMediaId, mediaId, readImportImage } from "./import-media.js"

const files = vi.hoisted(() => new Map<string, Buffer>())
vi.mock("../doc-version/doc-file.store.js", () => ({
  docFileStore: () => ({
    load: async (ref: string) => {
      const data = files.get(ref)
      if (!data) throw new Error(`không có file ${ref}`)
      return data
    }
  })
}))

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

  it("embeddableMediaPart: theo đuôi part Word đặt (png / jpg / jpeg) — không mở file", () => {
    for (const part of ["word/media/image1.png", "word/media/image2.JPG", "word/media/image3.jpeg"]) expect(embeddableMediaPart(part)).toBe(true)
    for (const part of ["word/media/image4.emf", "word/media/image5.wmf", "word/media/image6.gif", "word/media/png"]) expect(embeddableMediaPart(part)).toBe(false)
  })
})

describe("readImportImage — giữ lý do khi không đọc được ảnh gốc", () => {
  beforeEach(async () => {
    clearImportMediaCache()
    files.clear()
    const zip = new JSZip()
    zip.file("word/media/ok.png", buildPlaceholderPng(4, 4))
    // Đuôi .png nhưng bytes là EMF — đúng ca route phải báo "định dạng không hỗ trợ"
    zip.file("word/media/fake.png", Buffer.from([0x01, 0, 0, 0, 0x6c, 0, 0, 0, 0, 0]))
    files.set("F1", await zip.generateAsync({ type: "nodebuffer" }))
  })

  it("PNG thật ⇒ ok kèm mime", async () => {
    expect(await readImportImage("F1", "word/media/ok.png")).toMatchObject({ ok: true, image: { mime: "image/png" } })
  })

  it("bytes không phải PNG/JPEG ⇒ unsupported", async () => {
    expect(await readImportImage("F1", "word/media/fake.png")).toEqual({ ok: false, reason: "unsupported" })
  })

  it("file không có part ⇒ missing", async () => {
    expect(await readImportImage("F1", "word/media/none.png")).toEqual({ ok: false, reason: "missing" })
  })

  it("không tải được file gốc (storage lỗi) ⇒ unavailable, lượt sau thử lại được", async () => {
    expect(await readImportImage("F404", "word/media/ok.png")).toEqual({ ok: false, reason: "unavailable" })
    files.set("F404", files.get("F1")!)
    // Gói tải lỗi không được giữ trong cache — đợi một nhịp cho lượt dọn cache chạy
    await new Promise((r) => setTimeout(r, 0))
    expect(await readImportImage("F404", "word/media/ok.png")).toMatchObject({ ok: true })
  })
})
