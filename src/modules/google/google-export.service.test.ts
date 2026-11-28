import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OAuth2Client } from "google-auth-library"

const h = vi.hoisted(() => {
  type Link = Record<string, unknown> & { _id: string; exportedAt: Date }
  const links: Link[] = []
  let seq = 0

  const matches = (link: Link, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, value]) => link[key] === value)
  const newestFirst = (rows: Link[]) => [...rows].sort((a, b) => b.exportedAt.getTime() - a.exportedAt.getTime())

  const GoogleDocLink = {
    findOne: vi.fn((filter: Record<string, unknown>) => ({
      sort: async () => newestFirst(links.filter((l) => matches(l, filter)))[0] ?? null
    })),
    find: vi.fn((filter: Record<string, unknown>) => ({
      sort: () => ({ limit: async (n: number) => newestFirst(links.filter((l) => matches(l, filter))).slice(0, n) })
    })),
    create: vi.fn(async (doc: Record<string, unknown>) => {
      const link = { _id: `link-${++seq}`, ...doc } as Link
      links.push(link)
      return link
    }),
    updateOne: vi.fn(async (filter: { _id: string }, update: { $set: Record<string, unknown> }) => {
      const link = links.find((l) => l._id === filter._id)
      if (link) Object.assign(link, update.$set)
    })
  }

  const files = { get: vi.fn(), create: vi.fn(), update: vi.fn() }
  return { links, GoogleDocLink, files }
})

vi.mock("./google-doc-link.model.js", () => ({ GoogleDocLink: h.GoogleDocLink }))
vi.mock("@googleapis/drive", () => ({ drive: vi.fn(() => ({ files: h.files })) }))

const { exportToGoogleDocs, listLinks, GOOGLE_DOC_MIME } = await import("./google-export.service.js")

const DOCX = Buffer.from("PK\u0003\u0004 fake docx")
const auth = {} as OAuth2Client
const base = {
  auth,
  projectId: "p1",
  userId: "u1",
  docx: DOCX,
  fileName: "FAP_DRAFT.docx",
  source: "draft" as const,
  baselineId: null,
  lang: "vi"
}

const driveFile = (id: string, name = "FAP_DRAFT") => ({ data: { id, name, webViewLink: `https://docs.google.com/document/d/${id}/edit` } })

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.links.length = 0
})

describe("exportToGoogleDocs", () => {
  it("chưa có link ⇒ tạo Google Doc từ đúng file .docx, tên bỏ đuôi, lưu link", async () => {
    h.files.create.mockResolvedValue(driveFile("f1"))
    const result = await exportToGoogleDocs({ ...base, mode: "update" })

    expect(result).toEqual({ fileId: "f1", webViewLink: "https://docs.google.com/document/d/f1/edit", title: "FAP_DRAFT", mode: "new", recreated: false })
    const call = h.files.create.mock.calls[0][0]
    expect(call.requestBody).toEqual({ name: "FAP_DRAFT", mimeType: GOOGLE_DOC_MIME })
    expect(call.media.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(await readAll(call.media.body)).toEqual(DOCX)
    expect(h.links).toHaveLength(1)
    expect(h.links[0]).toMatchObject({ projectId: "p1", userId: "u1", fileId: "f1", source: "draft", lang: "vi", baselineId: null })
  })

  it("update khi đã có link cùng nguồn + ngôn ngữ ⇒ ghi đè đúng file đó, không thêm link", async () => {
    h.files.create.mockResolvedValue(driveFile("f1"))
    await exportToGoogleDocs({ ...base, mode: "new" })
    h.files.get.mockResolvedValue({ data: { id: "f1", trashed: false } })
    h.files.update.mockResolvedValue(driveFile("f1"))

    const result = await exportToGoogleDocs({ ...base, mode: "update" })
    expect(result).toMatchObject({ fileId: "f1", mode: "update", recreated: false })
    expect(h.files.update.mock.calls[0][0]).toMatchObject({ fileId: "f1", requestBody: { name: "FAP_DRAFT" } })
    expect(h.files.create).toHaveBeenCalledTimes(1)
    expect(h.links).toHaveLength(1)
  })

  it("ngôn ngữ hoặc nguồn khác ⇒ không đụng file cũ, tạo file mới", async () => {
    h.files.create.mockResolvedValueOnce(driveFile("f-vi")).mockResolvedValueOnce(driveFile("f-en"))
    await exportToGoogleDocs({ ...base, mode: "new" })
    const result = await exportToGoogleDocs({ ...base, lang: "en", mode: "update" })
    expect(result).toMatchObject({ fileId: "f-en", mode: "new" })
    expect(h.files.get).not.toHaveBeenCalled()
    expect(h.links).toHaveLength(2)
  })

  it.each([
    ["đã vào thùng rác", () => h.files.get.mockResolvedValue({ data: { id: "f1", trashed: true } })],
    ["đã bị xoá (404)", () => h.files.get.mockRejectedValue(Object.assign(new Error("nf"), { response: { status: 404 } }))]
  ])("file cũ %s ⇒ tạo lại, recreated: true, link trỏ file mới", async (_label, arrange) => {
    h.files.create.mockResolvedValueOnce(driveFile("f1")).mockResolvedValueOnce(driveFile("f2"))
    await exportToGoogleDocs({ ...base, mode: "new" })
    arrange()

    const result = await exportToGoogleDocs({ ...base, mode: "update" })
    expect(result).toMatchObject({ fileId: "f2", mode: "new", recreated: true })
    expect(h.files.update).not.toHaveBeenCalled()
    expect(h.links).toHaveLength(1)
    expect(h.links[0].fileId).toBe("f2")
  })

  it("mode new luôn tạo bản mới dù đã có link", async () => {
    h.files.create.mockResolvedValueOnce(driveFile("f1")).mockResolvedValueOnce(driveFile("f2"))
    await exportToGoogleDocs({ ...base, mode: "new" })
    const result = await exportToGoogleDocs({ ...base, mode: "new" })
    expect(result).toMatchObject({ fileId: "f2", mode: "new", recreated: false })
    expect(h.links).toHaveLength(2)
  })

  it("Drive báo hết dung lượng ⇒ 503 GOOGLE_DRIVE_QUOTA_EXCEEDED, không lưu link", async () => {
    h.files.create.mockRejectedValue(
      Object.assign(new Error("quota"), { response: { status: 403, data: { error: { errors: [{ reason: "storageQuotaExceeded" }] } } } })
    )
    await expect(exportToGoogleDocs({ ...base, mode: "new" })).rejects.toMatchObject({ statusCode: 503, code: "GOOGLE_DRIVE_QUOTA_EXCEEDED" })
    expect(h.links).toHaveLength(0)
  })
})

describe("listLinks", () => {
  it("chỉ link của user trong dự án, mới nhất trước", async () => {
    h.links.push(
      { _id: "a", projectId: "p1", userId: "u1", fileId: "old", title: "A", webViewLink: "l", source: "draft", lang: "vi", baselineId: null, exportedAt: new Date("2026-11-01") },
      { _id: "b", projectId: "p1", userId: "u1", fileId: "new", title: "B", webViewLink: "l", source: "baseline", lang: "vi", baselineId: "BL001", exportedAt: new Date("2026-11-10") },
      { _id: "c", projectId: "p1", userId: "u2", fileId: "other", title: "C", webViewLink: "l", source: "draft", lang: "vi", baselineId: null, exportedAt: new Date("2026-11-12") }
    )
    const result = await listLinks("p1", "u1")
    expect(result.map((l) => l.fileId)).toEqual(["new", "old"])
    expect(result[0]).toEqual({ fileId: "new", title: "B", webViewLink: "l", source: "baseline", lang: "vi", baselineId: "BL001", exportedAt: new Date("2026-11-10") })
  })
})
