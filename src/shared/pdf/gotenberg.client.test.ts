/**
 * gotenberg.client (FLF-316) — `fetch` bị mock; ca cuối gọi Gotenberg thật, tự skip khi không có server
 * (như `plantuml.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { docxToPdf, isGotenbergReachable, PdfConverterError } from "./gotenberg.client.js"
import { env } from "../../config/env.js"

const PDF = Buffer.from("%PDF-1.7\n%%EOF\n")
const DOCX = Buffer.from("PK\u0003\u0004fake-docx")

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("docxToPdf", () => {
  it("POST multipart tới /forms/libreoffice/convert kèm file .docx và updateIndexes=true", async () => {
    fetchMock.mockResolvedValue(new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } }))

    const out = await docxToPdf(DOCX, "lumen-v0.3-draft.docx")
    expect(out).toEqual(PDF)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${env.GOTENBERG_URL.replace(/\/+$/, "")}/forms/libreoffice/convert`)
    expect(init?.method).toBe("POST")
    const form = init?.body as FormData
    const file = form.get("files") as File
    expect(file.name).toBe("lumen-v0.3-draft.docx")
    expect(Buffer.from(await file.arrayBuffer())).toEqual(DOCX)
    expect(form.get("updateIndexes")).toBe("true")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("Gotenberg trả lỗi HTTP ⇒ PdfConverterError kèm status", async () => {
    fetchMock.mockResolvedValue(new Response("LibreOffice failed", { status: 500 }))
    await expect(docxToPdf(DOCX, "a.docx")).rejects.toThrow(PdfConverterError)
    fetchMock.mockResolvedValue(new Response("LibreOffice failed", { status: 500 }))
    await expect(docxToPdf(DOCX, "a.docx")).rejects.toThrow(/HTTP 500/)
  })

  it("200 nhưng không phải PDF (server lạ chiếm cổng) ⇒ PdfConverterError", async () => {
    fetchMock.mockResolvedValue(new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } }))
    await expect(docxToPdf(DOCX, "a.docx")).rejects.toThrow(/không phải Gotenberg/)
  })

  it("không kết nối được ⇒ PdfConverterError", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"))
    await expect(docxToPdf(DOCX, "a.docx")).rejects.toThrow(/không gọi được Gotenberg/)
  })

  it("quá GOTENBERG_TIMEOUT_MS ⇒ huỷ request, PdfConverterError nói rõ quá hạn", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
          })
      )
      const pending = expect(docxToPdf(DOCX, "a.docx")).rejects.toThrow(/quá \d+ ms/)
      await vi.advanceTimersByTimeAsync(env.GOTENBERG_TIMEOUT_MS + 1)
      await pending
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("isGotenbergReachable", () => {
  it("/health trả status up ⇒ true", async () => {
    fetchMock.mockResolvedValue(Response.json({ status: "up" }))
    expect(await isGotenbergReachable()).toBe(true)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/health$/)
  })

  it("200 nhưng không phải health của Gotenberg ⇒ false", async () => {
    fetchMock.mockResolvedValue(new Response("<html></html>", { status: 200 }))
    expect(await isGotenbergReachable()).toBe(false)
  })

  it("503 hoặc lỗi mạng ⇒ false", async () => {
    fetchMock.mockResolvedValue(Response.json({ status: "down" }, { status: 503 }))
    expect(await isGotenbergReachable()).toBe(false)
    fetchMock.mockRejectedValue(new TypeError("fetch failed"))
    expect(await isGotenbergReachable()).toBe(false)
  })
})

// Gotenberg thật (docker compose up -d gotenberg) — không có server thì skip.
const live = await isGotenbergReachable()

describe.skipIf(!live)("Gotenberg thật", () => {
  it("chuyển .docx mẫu của writer thành PDF", async () => {
    vi.unstubAllGlobals()
    const { writeDocx } = await import("../../modules/render/docx-writer.js")
    const { renderedDocumentSchema } = await import("../../modules/render/rendered-document.schema.js")
    const sample = renderedDocumentSchema.parse(
      JSON.parse(readFileSync(new URL("../../../fixtures/rendered-document-sample.json", import.meta.url), "utf8"))
    )
    const pdf = await docxToPdf(await writeDocx(sample), "sample.docx")
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    expect(pdf.length).toBeGreaterThan(5000)
  }, 60_000)
})
