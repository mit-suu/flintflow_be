import { describe, expect, it, vi } from "vitest"
import { createMemoryDiagramStore } from "../diagram/diagram-file.store.js"
import { localizedDiagramHash } from "../diagram/localized-diagram.service.js"
import { formatImageRef, mediaHash, parseImageRef, readImageRef, refDiagramPngLoader, refLocalizedPngLoader } from "./image-ref.js"

const PROJECT = "650000000000000000000001"
const png = (text: string) => ({ data: Buffer.from(text), contentType: "image/png" })
const SOURCE = { format: "svg" as const, source: "<svg>vi</svg>" }

describe("chuỗi tham chiếu image-ref", () => {
  it("định dạng ⇄ phân tích: sơ đồ, bản dịch, media có dấu / trong part", () => {
    for (const ref of [
      { kind: "diagram" as const, id: "D02-3", hash: "0123456789abcdef" },
      { kind: "diagram" as const, id: "D02", locale: "vi", hash: "fedcba9876543210" },
      { kind: "media" as const, id: "word/media/image3.png", hash: "00112233445566aa" }
    ]) {
      const token = formatImageRef(ref)
      expect(token.startsWith("image-ref:")).toBe(true)
      expect(parseImageRef(token)).toEqual(ref)
    }
    expect(formatImageRef({ kind: "media", id: "word/media/a.png", hash: "0".repeat(16) })).toBe(`image-ref:media:word%2Fmedia%2Fa.png@${"0".repeat(16)}`)
  })

  it("sai dạng ⇒ null (kind lạ, hash ngắn, locale lạ, base64, %-encode hỏng)", () => {
    for (const bad of ["image-ref:file:D01@0123456789abcdef", "image-ref:diagram:D01@0123", "image-ref:diagram:D01:vie@0123456789abcdef", "iVBORw0KGgo=", "image-ref:diagram:%E0%A4%A@0123456789abcdef"]) {
      expect(parseImageRef(bad), bad).toBeNull()
    }
  })
})

describe("loader chế độ tham chiếu", () => {
  it("sơ đồ: chưa có file ⇒ null; có ⇒ tham chiếu; ghi lại (kể cả cùng bytes, như vẽ ép) ⇒ hash đổi", async () => {
    const store = createMemoryDiagramStore()
    expect(await refDiagramPngLoader(store)(PROJECT, "D01")).toBeNull()
    await store.save(PROJECT, "D01", "png", png("a"))
    const first = await refDiagramPngLoader(store)(PROJECT, "D01")
    expect(parseImageRef(first!)).toMatchObject({ kind: "diagram", id: "D01" })
    await store.save(PROJECT, "D01", "png", png("a"))
    const second = await refDiagramPngLoader(store)(PROJECT, "D01")
    expect(second).not.toBe(first)
    // một loader (một lượt dựng) đọc metadata một lần
    const spy = vi.spyOn(store, "statAllPng")
    const load = refDiagramPngLoader(store)
    await load(PROJECT, "D01")
    await load(PROJECT, "D02")
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("media: hash theo (file_ref, part), không mở file gốc; một lượt dựng hỏi file_ref một lần; không nhúng được ⇒ null", async () => {
    const fileRefOf = vi.fn(async () => "F1")
    const load = refDiagramPngLoader(createMemoryDiagramStore(), fileRefOf)
    expect(await load(PROJECT, "media:word/media/a.png")).toBe(formatImageRef({ kind: "media", id: "word/media/a.png", hash: mediaHash("F1", "word/media/a.png") }))
    expect(parseImageRef((await load(PROJECT, "media:word/media/c.jpeg"))!)).toMatchObject({ kind: "media", id: "word/media/c.jpeg" })
    expect(await load(PROJECT, "media:word/media/b.emf")).toBeNull()
    expect(fileRefOf).toHaveBeenCalledTimes(1)
    // Cùng ảnh, lượt dựng khác ⇒ cùng tham chiếu (FE giữ Blob); upload lại (file_ref mới) ⇒ tham chiếu mới
    expect(await refDiagramPngLoader(createMemoryDiagramStore(), async () => "F1")(PROJECT, "media:word/media/a.png")).toBe(await load(PROJECT, "media:word/media/a.png"))
    expect(await refDiagramPngLoader(createMemoryDiagramStore(), async () => "F2")(PROJECT, "media:word/media/a.png")).not.toBe(await load(PROJECT, "media:word/media/a.png"))
    // Dự án không có file gốc ⇒ null (placeholder)
    expect(await refDiagramPngLoader(createMemoryDiagramStore(), async () => null)(PROJECT, "media:word/media/a.png")).toBeNull()
  })

  it("bản dịch: file đã có ⇒ tham chiếu, không vẽ; chưa có ⇒ vẽ rồi trả tham chiếu; vẽ hỏng ⇒ null (dùng ảnh gốc)", async () => {
    const store = createMemoryDiagramStore()
    const hash = localizedDiagramHash("vi", SOURCE.source)
    await store.saveLocalized(PROJECT, "D01", "vi", hash, png("vi"))
    const draw = vi.fn(async () => "cG5n")
    expect(await refLocalizedPngLoader(store, draw)(PROJECT, "D01", "vi", SOURCE)).toBe(formatImageRef({ kind: "diagram", id: "D01", locale: "vi", hash }))
    expect(draw).not.toHaveBeenCalled()
    expect(await refLocalizedPngLoader(store, draw)(PROJECT, "D02", "vi", SOURCE)).toBe(formatImageRef({ kind: "diagram", id: "D02", locale: "vi", hash }))
    expect(draw).toHaveBeenCalledTimes(1)
    expect(await refLocalizedPngLoader(store, async () => null)(PROJECT, "D03", "vi", SOURCE)).toBeNull()
  })
})

describe("readImageRef — chỉ đọc", () => {
  it("sơ đồ gốc: đúng hash ⇒ bytes; vẽ lại sau đó ⇒ changed; thiếu ⇒ not_found", async () => {
    const store = createMemoryDiagramStore()
    await store.save(PROJECT, "D01", "png", png("old"))
    const ref = parseImageRef((await refDiagramPngLoader(store)(PROJECT, "D01"))!)!
    expect(await readImageRef(PROJECT, ref, store)).toMatchObject({ ok: true, data: Buffer.from("old") })
    await store.save(PROJECT, "D01", "png", png("new"))
    expect(await readImageRef(PROJECT, ref, store)).toEqual({ ok: false, reason: "changed" })
    expect(await readImageRef(PROJECT, { ...ref, id: "D09" }, store)).toEqual({ ok: false, reason: "not_found" })
  })

  it("bản dịch: theo đúng hash tên file, thiếu ⇒ not_found (không vẽ)", async () => {
    const store = createMemoryDiagramStore()
    const hash = localizedDiagramHash("vi", SOURCE.source)
    expect(await readImageRef(PROJECT, { kind: "diagram", id: "D01", locale: "vi", hash }, store)).toEqual({ ok: false, reason: "not_found" })
    await store.saveLocalized(PROJECT, "D01", "vi", hash, png("vi"))
    expect(await readImageRef(PROJECT, { kind: "diagram", id: "D01", locale: "vi", hash }, store)).toMatchObject({ ok: true, data: Buffer.from("vi") })
  })

  it("media: upload lại (file_ref đổi) ⇒ changed, không tải bytes; thiếu file / part ⇒ not_found; content type theo magic bytes", async () => {
    const pngBytes = Buffer.from("89504e470d0a1a0a0000", "hex")
    let fileRef: string | null = "F1"
    const fileRefOf = async () => fileRef
    const loadMedia = vi.fn(async (_p: string, part: string) => (part === "word/media/a.png" ? { mime: "image/png" as const, data: pngBytes.toString("base64") } : null))
    const store = createMemoryDiagramStore()
    const ref = parseImageRef((await refDiagramPngLoader(store, fileRefOf)(PROJECT, "media:word/media/a.png"))!)!
    expect(await readImageRef(PROJECT, ref, store, loadMedia, fileRefOf)).toMatchObject({ ok: true, data: pngBytes, contentType: "image/png" })
    expect(await readImageRef(PROJECT, { ...ref, id: "word/media/z.png", hash: mediaHash("F1", "word/media/z.png") }, store, loadMedia, fileRefOf)).toEqual({ ok: false, reason: "not_found" })
    loadMedia.mockClear()
    fileRef = "F2"
    expect(await readImageRef(PROJECT, ref, store, loadMedia, fileRefOf)).toEqual({ ok: false, reason: "changed" })
    expect(loadMedia).not.toHaveBeenCalled()
    fileRef = null
    expect(await readImageRef(PROJECT, ref, store, loadMedia, fileRefOf)).toEqual({ ok: false, reason: "not_found" })
  })
})
