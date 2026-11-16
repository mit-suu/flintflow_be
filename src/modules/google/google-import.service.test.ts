import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OAuth2Client } from "google-auth-library"

const h = vi.hoisted(() => ({ files: { get: vi.fn(), export: vi.fn() } }))
vi.mock("@googleapis/drive", () => ({ drive: vi.fn(() => ({ files: h.files })) }))

const { fetchDocxFromDrive, DOCX_MIME } = await import("./google-import.service.js")
const { IMPORT_MAX_FILE_BYTES } = await import("../import/import.constants.js")

const auth = {} as OAuth2Client
const GDOC = "application/vnd.google-apps.document"
const bytes = (text: string) => {
  const buf = Buffer.from(text)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
}
const meta = (over: Record<string, unknown>) => ({ data: { id: "f1", name: "SRS Bán Vé", trashed: false, ...over } })

beforeEach(() => vi.clearAllMocks())

describe("fetchDocxFromDrive", () => {
  it("Google Doc ⇒ xuất sang .docx, tên thêm đuôi .docx (giữ chữ tiếng Việt)", async () => {
    h.files.get.mockResolvedValueOnce(meta({ mimeType: GDOC }))
    h.files.export.mockResolvedValue({ data: bytes("PK docx từ google") })

    const file = await fetchDocxFromDrive(auth, "f1")
    expect(h.files.export).toHaveBeenCalledWith({ fileId: "f1", mimeType: DOCX_MIME }, { responseType: "arraybuffer" })
    expect(file).toEqual({ buffer: Buffer.from("PK docx từ google"), originalname: "SRS Bán Vé.docx", size: Buffer.byteLength("PK docx từ google") })
  })

  it(".docx trên Drive ⇒ tải nguyên file, không xuất; tên đã có đuôi thì giữ", async () => {
    h.files.get.mockResolvedValueOnce(meta({ mimeType: DOCX_MIME, name: "SRS.docx", size: "1234" }))
    h.files.get.mockResolvedValueOnce({ data: bytes("PK file word") })

    const file = await fetchDocxFromDrive(auth, "f1")
    expect(h.files.get).toHaveBeenLastCalledWith({ fileId: "f1", alt: "media" }, { responseType: "arraybuffer" })
    expect(h.files.export).not.toHaveBeenCalled()
    expect(file.originalname).toBe("SRS.docx")
    expect(file.buffer.toString()).toBe("PK file word")
  })

  it(".docx quá gấp đôi giới hạn import ⇒ 413 FILE_TOO_LARGE, không tải", async () => {
    h.files.get.mockResolvedValueOnce(meta({ mimeType: DOCX_MIME, size: String(IMPORT_MAX_FILE_BYTES * 2 + 1) }))
    await expect(fetchDocxFromDrive(auth, "f1")).rejects.toMatchObject({ statusCode: 413, code: "FILE_TOO_LARGE" })
    expect(h.files.get).toHaveBeenCalledTimes(1)
  })

  it("Google Doc quá lớn để xuất ⇒ 413 GOOGLE_EXPORT_TOO_LARGE", async () => {
    h.files.get.mockResolvedValueOnce(meta({ mimeType: GDOC }))
    h.files.export.mockRejectedValue(
      Object.assign(new Error("too large"), { response: { status: 403, data: { error: { errors: [{ reason: "exportSizeLimitExceeded" }] } } } })
    )
    await expect(fetchDocxFromDrive(auth, "f1")).rejects.toMatchObject({ statusCode: 413, code: "GOOGLE_EXPORT_TOO_LARGE" })
  })

  it.each([["PDF", "application/pdf"], ["Google Sheets", "application/vnd.google-apps.spreadsheet"]])(
    "%s ⇒ 400 GOOGLE_FILE_UNSUPPORTED",
    async (_label, mimeType) => {
      h.files.get.mockResolvedValueOnce(meta({ mimeType }))
      await expect(fetchDocxFromDrive(auth, "f1")).rejects.toMatchObject({ statusCode: 400, code: "GOOGLE_FILE_UNSUPPORTED" })
    }
  )

  it("file trong thùng rác ⇒ 404; Drive 404 / 403 ⇒ mã Google tương ứng", async () => {
    h.files.get.mockResolvedValueOnce(meta({ mimeType: GDOC, trashed: true }))
    await expect(fetchDocxFromDrive(auth, "f1")).rejects.toMatchObject({ code: "GOOGLE_FILE_NOT_FOUND" })

    h.files.get.mockRejectedValueOnce(Object.assign(new Error("nf"), { response: { status: 404 } }))
    await expect(fetchDocxFromDrive(auth, "f1")).rejects.toMatchObject({ code: "GOOGLE_FILE_NOT_FOUND" })

    h.files.get.mockRejectedValueOnce(Object.assign(new Error("denied"), { response: { status: 403, data: { error: { errors: [{ reason: "appNotAuthorizedToFile" }] } } } }))
    await expect(fetchDocxFromDrive(auth, "f1")).rejects.toMatchObject({ code: "GOOGLE_FILE_FORBIDDEN" })
  })
})
