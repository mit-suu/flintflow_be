import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Readable } from "node:stream"
import { v2 as cloudinary } from "cloudinary"
import { contentTypeOfExtension, DOWNLOAD_MAX_BYTES, openDocumentDownload } from "./project-document.storage.js"

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

const respond = (body: string | Uint8Array, init: ResponseInit = {}): Response => new Response(body as BodyInit, { status: 200, ...init })

beforeAll(() => {
  cloudinary.config({ cloud_name: "demo-cloud", api_key: "k", api_secret: "s" })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("contentTypeOfExtension", () => {
  it("bảng cố định cho 5 đuôi được phép, không phân biệt hoa thường", () => {
    expect(contentTypeOfExtension(".pdf")).toBe("application/pdf")
    expect(contentTypeOfExtension(".DOCX")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(contentTypeOfExtension(".doc")).toBe("application/msword")
    expect(contentTypeOfExtension(".md")).toBe("text/markdown; charset=utf-8")
    expect(contentTypeOfExtension(".txt")).toBe("text/plain; charset=utf-8")
  })

  it("đuôi lạ / thiếu ⇒ octet-stream (không bao giờ text/html)", () => {
    expect(contentTypeOfExtension(".html")).toBe("application/octet-stream")
    expect(contentTypeOfExtension(".svg")).toBe("application/octet-stream")
    expect(contentTypeOfExtension(null)).toBe("application/octet-stream")
    expect(contentTypeOfExtension(undefined)).toBe("application/octet-stream")
  })
})

describe("openDocumentDownload", () => {
  it("dựng URL raw từ khoá lưu, không dùng URL đã lưu; trả đúng byte", async () => {
    const fetchMock = vi.fn(async () => respond("hello", { headers: { "content-length": "5" } }))
    vi.stubGlobal("fetch", fetchMock)

    const download = await openDocumentDownload("flintflow/projects/p1/notes.txt", ".txt")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL((fetchMock.mock.calls[0] as unknown[])[0] as string)
    expect(url.origin).toBe("https://res.cloudinary.com")
    expect(url.pathname).toMatch(/^\/demo-cloud\/raw\/upload\/(v\d+\/)?flintflow\/projects\/p1\/notes\.txt$/)
    expect(download.contentLength).toBe(5)
    expect((await readAll(download.stream)).toString()).toBe("hello")
  })

  it("khoá lưu không kèm đuôi mà kho trả 404 ⇒ thử lại với đuôi", async () => {
    const fetchMock = vi.fn(async (url: string) => (new URL(url).pathname.endsWith(".txt") ? respond("ok") : respond("nope", { status: 404 })))
    vi.stubGlobal("fetch", fetchMock)

    const download = await openDocumentDownload("flintflow/projects/p1/notes", ".txt")

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await readAll(download.stream)).toString()).toBe("ok")
  })

  it("kho trả 404 ở mọi lần thử ⇒ 503 DOCUMENT_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond("nope", { status: 404 })))
    await expect(openDocumentDownload("a/b", ".pdf")).rejects.toMatchObject({ statusCode: 503, code: "DOCUMENT_UNAVAILABLE" })
  })

  it("kho trả 5xx / 401 ⇒ 503, không thử đuôi nữa", async () => {
    const fetchMock = vi.fn(async () => respond("x", { status: 401 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(openDocumentDownload("a/b", ".pdf")).rejects.toMatchObject({ statusCode: 503, code: "DOCUMENT_UNAVAILABLE" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("lỗi mạng ⇒ 503", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed") }))
    await expect(openDocumentDownload("a/b", ".pdf")).rejects.toMatchObject({ statusCode: 503, code: "DOCUMENT_UNAVAILABLE" })
  })

  it("quá thời gian ⇒ 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
      }))
    )
    await expect(openDocumentDownload("a/b", ".pdf", { timeoutMs: 20 })).rejects.toMatchObject({ statusCode: 503, code: "DOCUMENT_UNAVAILABLE" })
  })

  it("thiếu khoá lưu ⇒ 503 mà không gọi kho", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(openDocumentDownload(null, ".pdf")).rejects.toMatchObject({ statusCode: 503, code: "DOCUMENT_UNAVAILABLE" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("kho báo kích thước vượt trần ⇒ 503 trước khi stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond("x", { headers: { "content-length": String(DOWNLOAD_MAX_BYTES + 1) } })))
    await expect(openDocumentDownload("a/b", ".pdf")).rejects.toMatchObject({ statusCode: 503, code: "DOCUMENT_UNAVAILABLE" })
  })

  it("kho không báo kích thước mà luồng vượt trần ⇒ luồng lỗi giữa chừng", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(new Uint8Array(64))))
    const download = await openDocumentDownload("a/b", ".pdf", { maxBytes: 16 })
    await expect(readAll(download.stream)).rejects.toThrow(/vượt/)
  })
})
