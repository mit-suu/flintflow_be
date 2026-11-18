import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OAuth2Client } from "google-auth-library"

const h = vi.hoisted(() => {
  type Link = Record<string, unknown> & { _id: string; exportedAt: Date }
  const links: Link[] = []
  let seq = 0

  const matches = (link: Link, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, value]) => {
      if (value && typeof value === "object" && "$ne" in value) return link[key] !== (value as { $ne: unknown }).$ne
      return link[key] === value
    })
  const newestFirst = (rows: Link[]) => [...rows].sort((a, b) => b.exportedAt.getTime() - a.exportedAt.getTime())

  const GoogleDocLink = {
    findOne: vi.fn((filter: Record<string, unknown>) => ({
      sort: async () => newestFirst(links.filter((l) => matches(l, filter)))[0] ?? null
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

  /** Thư mục app đã tạo trên "Drive": key appProperties → { id, name }. */
  const folders = new Map<string, { id: string; name: string }>()
  const files = {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    list: vi.fn(async ({ q }: { q: string }) => {
      const m = q.match(/key='(\w+)' and value='(\w+)'/)
      const found = m ? folders.get(`${m[1]}=${m[2]}`) : undefined
      return { data: { files: found ? [found] : [] } }
    })
  }
  return { links, GoogleDocLink, files, folders }
})

vi.mock("./google-doc-link.model.js", () => ({ GoogleDocLink: h.GoogleDocLink }))
vi.mock("@googleapis/drive", () => ({ drive: vi.fn(() => ({ files: h.files })) }))

const { exportToGoogleDocs, GOOGLE_DOC_MIME, FOLDER_MIME } = await import("./google-export.service.js")

const DOCX = Buffer.from("PK\u0003\u0004 fake docx")
const auth = {} as OAuth2Client
const base = {
  auth,
  projectId: "p1",
  projectName: "Đặt lịch khám",
  userId: "u1",
  docx: DOCX,
  fileName: "FAP_DRAFT.docx",
  source: "draft" as const,
  baselineId: null,
  lang: "vi",
  spineVersion: 7,
  force: false
}

const ROOT = { id: "root-ff", name: "FlintFlow" }
const PROJECT_FOLDER = { id: "folder-p1", name: "Đặt lịch khám" }

const driveFile = (id: string, version = "10", parents = [PROJECT_FOLDER.id]) => ({
  data: { id, name: "FAP_DRAFT", webViewLink: `https://docs.google.com/document/d/${id}/edit`, version, parents }
})

/** Drive tạo thư mục khi được gọi `create` với mimeType folder; file thường trả theo `fileResponses`. */
const arrangeCreate = (...fileResponses: ReturnType<typeof driveFile>[]) => {
  h.files.create.mockImplementation(async ({ requestBody }: { requestBody: { mimeType: string; appProperties?: Record<string, string> } }) => {
    if (requestBody.mimeType === FOLDER_MIME) {
      const [key, value] = Object.entries(requestBody.appProperties ?? {})[0]
      const folder = key === "flintflowRoot" ? ROOT : PROJECT_FOLDER
      h.folders.set(`${key}=${value}`, folder)
      return { data: folder }
    }
    const next = fileResponses.shift()
    if (!next) throw new Error("unexpected files.create")
    return next
  })
}

const fileCreates = () => h.files.create.mock.calls.map(([arg]) => arg).filter((arg) => arg.requestBody.mimeType === GOOGLE_DOC_MIME)

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.links.length = 0
  h.folders.clear()
})

describe("exportToGoogleDocs", () => {
  it("lần đầu ⇒ tạo FlintFlow / <dự án> rồi tạo Google Doc trong đó từ đúng file .docx, lưu version + spine_version", async () => {
    arrangeCreate(driveFile("f1"))
    const result = await exportToGoogleDocs({ ...base, mode: "update" })

    expect(result).toEqual({
      fileId: "f1",
      webViewLink: "https://docs.google.com/document/d/f1/edit",
      title: "FAP_DRAFT",
      mode: "new",
      recreated: false,
      folder: { id: "folder-p1", path: "FlintFlow / Đặt lịch khám", url: "https://drive.google.com/drive/folders/folder-p1" }
    })
    const folderCalls = h.files.create.mock.calls.map(([arg]) => arg.requestBody).filter((b) => b.mimeType === FOLDER_MIME)
    expect(folderCalls).toEqual([
      { name: "FlintFlow", mimeType: FOLDER_MIME, appProperties: { flintflowRoot: "1" } },
      { name: "Đặt lịch khám", mimeType: FOLDER_MIME, parents: ["root-ff"], appProperties: { flintflowProjectId: "p1" } }
    ])
    const [call] = fileCreates()
    expect(call.requestBody).toEqual({ name: "FAP_DRAFT", mimeType: GOOGLE_DOC_MIME, parents: ["folder-p1"] })
    expect(await readAll(call.media.body)).toEqual(DOCX)
    expect(h.links[0]).toMatchObject({
      projectId: "p1",
      userId: "u1",
      kind: "export",
      fileId: "f1",
      driveVersion: "10",
      exportedSpineVersion: 7,
      folderId: "folder-p1",
      folderPath: "FlintFlow / Đặt lịch khám"
    })
  })

  it("thư mục đã có ⇒ dùng lại, không tạo thêm; dự án đổi tên ⇒ đổi tên thư mục", async () => {
    h.folders.set("flintflowRoot=1", ROOT)
    h.folders.set("flintflowProjectId=p1", { id: "folder-p1", name: "Tên cũ" })
    arrangeCreate(driveFile("f1"))
    await exportToGoogleDocs({ ...base, mode: "new" })

    expect(h.files.create.mock.calls.filter(([arg]) => arg.requestBody.mimeType === FOLDER_MIME)).toHaveLength(0)
    expect(h.files.update).toHaveBeenCalledWith({ fileId: "folder-p1", requestBody: { name: "Đặt lịch khám" } })
  })

  it("update khi Doc chưa bị sửa ⇒ ghi đè đúng file, không thêm link, cập nhật version", async () => {
    arrangeCreate(driveFile("f1", "10"))
    await exportToGoogleDocs({ ...base, mode: "new" })
    h.files.get.mockResolvedValue({ data: { id: "f1", trashed: false, version: "10", parents: ["folder-p1"] } })
    h.files.update.mockResolvedValue(driveFile("f1", "12"))

    const result = await exportToGoogleDocs({ ...base, spineVersion: 9, mode: "update" })
    expect(result).toMatchObject({ fileId: "f1", mode: "update", recreated: false })
    const call = h.files.update.mock.calls.find(([arg]) => arg.fileId === "f1")![0]
    expect(call).toMatchObject({ fileId: "f1", requestBody: { name: "FAP_DRAFT" } })
    expect(call.addParents).toBeUndefined()
    expect(h.links).toHaveLength(1)
    expect(h.links[0]).toMatchObject({ driveVersion: "12", exportedSpineVersion: 9 })
  })

  it("Doc đã bị sửa trong Google Docs ⇒ 409 GOOGLE_DOC_MODIFIED, không ghi; force ⇒ ghi đè", async () => {
    arrangeCreate(driveFile("f1", "10"))
    await exportToGoogleDocs({ ...base, mode: "new" })
    h.files.get.mockResolvedValue({ data: { id: "f1", trashed: false, version: "15", parents: ["folder-p1"] } })

    await expect(exportToGoogleDocs({ ...base, mode: "update" })).rejects.toMatchObject({ statusCode: 409, code: "GOOGLE_DOC_MODIFIED" })
    expect(h.files.update).not.toHaveBeenCalled()

    h.files.update.mockResolvedValue(driveFile("f1", "16"))
    const forced = await exportToGoogleDocs({ ...base, mode: "update", force: true })
    expect(forced).toMatchObject({ fileId: "f1", mode: "update" })
    expect(h.links[0].driveVersion).toBe("16")
  })

  it("bản xuất cũ nằm ngoài thư mục ⇒ chuyển vào thư mục dự án khi cập nhật", async () => {
    h.links.push({ _id: "old", projectId: "p1", userId: "u1", fileId: "f-old", source: "draft", baselineId: null, lang: "vi", exportedAt: new Date("2026-11-01") })
    arrangeCreate()
    h.files.get.mockResolvedValue({ data: { id: "f-old", trashed: false, version: "3", parents: ["my-drive-root"] } })
    h.files.update.mockResolvedValue(driveFile("f-old", "4"))

    const result = await exportToGoogleDocs({ ...base, mode: "update" })
    expect(result).toMatchObject({ fileId: "f-old", mode: "update", folder: { id: "folder-p1" } })
    expect(h.files.update.mock.calls.find(([arg]) => arg.fileId === "f-old")![0]).toMatchObject({ addParents: "folder-p1", removeParents: "my-drive-root" })
    expect(h.links[0]).toMatchObject({ kind: "export", folderId: "folder-p1" })
  })

  it("Drive không cho chuyển file ⇒ vẫn ghi nội dung, folder: null", async () => {
    h.links.push({ _id: "old", projectId: "p1", userId: "u1", fileId: "f-old", source: "draft", baselineId: null, lang: "vi", exportedAt: new Date("2026-11-01") })
    arrangeCreate()
    h.files.get.mockResolvedValue({ data: { id: "f-old", trashed: false, version: "3", parents: ["shared-folder"] } })
    h.files.update
      .mockRejectedValueOnce(Object.assign(new Error("forbidden"), { response: { status: 403 } }))
      .mockResolvedValueOnce(driveFile("f-old", "4", ["shared-folder"]))

    const result = await exportToGoogleDocs({ ...base, mode: "update" })
    expect(result).toMatchObject({ fileId: "f-old", mode: "update", folder: null })
    expect(h.links[0]).toMatchObject({ folderId: null, folderPath: null })
  })

  it("Doc liên kết (của khách) không bao giờ bị ghi đè ⇒ tạo file mới", async () => {
    h.links.push({ _id: "lk", projectId: "p1", userId: "u1", kind: "linked", fileId: "client-doc", source: null, baselineId: null, lang: null, exportedAt: new Date() })
    h.links.push({ _id: "lk2", projectId: "p1", userId: "u1", kind: "linked", fileId: "client-doc-2", source: "draft", baselineId: null, lang: "vi", exportedAt: new Date() })
    arrangeCreate(driveFile("f-new"))

    const result = await exportToGoogleDocs({ ...base, mode: "update" })
    expect(result).toMatchObject({ fileId: "f-new", mode: "new", recreated: false })
    expect(h.files.get).not.toHaveBeenCalled()
    expect(h.links.find((l) => l._id === "lk2")?.fileId).toBe("client-doc-2")
  })

  it.each([
    ["đã vào thùng rác", () => h.files.get.mockResolvedValue({ data: { id: "f1", trashed: true } })],
    ["đã bị xoá (404)", () => h.files.get.mockRejectedValue(Object.assign(new Error("nf"), { response: { status: 404 } }))]
  ])("file cũ %s ⇒ tạo lại, recreated: true, link trỏ file mới", async (_label, arrange) => {
    arrangeCreate(driveFile("f1"), driveFile("f2"))
    await exportToGoogleDocs({ ...base, mode: "new" })
    arrange()

    const result = await exportToGoogleDocs({ ...base, mode: "update" })
    expect(result).toMatchObject({ fileId: "f2", mode: "new", recreated: true })
    expect(h.links).toHaveLength(1)
    expect(h.links[0].fileId).toBe("f2")
  })

  it("ngôn ngữ khác hoặc mode new ⇒ tạo file mới, không đụng file cũ", async () => {
    arrangeCreate(driveFile("f-vi"), driveFile("f-en"), driveFile("f-vi-2"))
    await exportToGoogleDocs({ ...base, mode: "new" })
    expect(await exportToGoogleDocs({ ...base, lang: "en", mode: "update" })).toMatchObject({ fileId: "f-en", mode: "new" })
    expect(await exportToGoogleDocs({ ...base, mode: "new" })).toMatchObject({ fileId: "f-vi-2", mode: "new" })
    expect(h.files.get).not.toHaveBeenCalled()
    expect(h.links).toHaveLength(3)
  })

  it("Drive báo hết dung lượng ⇒ 503 GOOGLE_DRIVE_QUOTA_EXCEEDED, không lưu link", async () => {
    h.files.list.mockRejectedValueOnce(
      Object.assign(new Error("quota"), { response: { status: 403, data: { error: { errors: [{ reason: "storageQuotaExceeded" }] } } } })
    )
    await expect(exportToGoogleDocs({ ...base, mode: "new" })).rejects.toMatchObject({ statusCode: 503, code: "GOOGLE_DRIVE_QUOTA_EXCEEDED" })
    expect(h.links).toHaveLength(0)
  })
})
