import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OAuth2Client } from "google-auth-library"

const h = vi.hoisted(() => {
  type Link = Record<string, unknown> & { _id: string; exportedAt: Date }
  const links: Link[] = []
  let seq = 0
  const matches = (link: Link, filter: Record<string, unknown>) => Object.entries(filter).every(([key, value]) => link[key] === value)
  const newestFirst = (rows: Link[]) => [...rows].sort((a, b) => b.exportedAt.getTime() - a.exportedAt.getTime())

  const GoogleDocLink = {
    find: vi.fn((filter: Record<string, unknown>) => ({
      sort: () => ({ limit: async (n: number) => newestFirst(links.filter((l) => matches(l, filter))).slice(0, n) })
    })),
    findOne: vi.fn((filter: Record<string, unknown>) => ({ sort: async () => newestFirst(links.filter((l) => matches(l, filter)))[0] ?? null })),
    create: vi.fn(async (doc: Record<string, unknown>) => {
      const link = { _id: `link-${++seq}`, ...doc } as Link
      links.push(link)
      return link
    }),
    deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
      const before = links.length
      for (let i = links.length - 1; i >= 0; i--) if (matches(links[i], filter)) links.splice(i, 1)
      return { deletedCount: before - links.length }
    }),
    exists: vi.fn(async (filter: Record<string, unknown>) => (links.some((l) => matches(l, filter)) ? { _id: "x" } : null))
  }
  const User = {
    find: vi.fn(() => ({
      select: () => ({
        lean: async () => [
          { _id: "u1", name: "An", email: "an@example.com" },
          { _id: "u2", name: "Bình", email: "binh@example.com" }
        ]
      })
    }))
  }
  const versionHead = vi.fn(async () => ({ spine_version: 12, content_seq: 3, identity: "x" }))
  const files = { get: vi.fn() }
  return { links, GoogleDocLink, User, versionHead, files }
})

vi.mock("./google-doc-link.model.js", () => ({ GoogleDocLink: h.GoogleDocLink }))
vi.mock("../user/user.model.js", () => ({ User: h.User }))
vi.mock("../spine/spine.repository.js", () => ({ versionHead: h.versionHead }))
vi.mock("@googleapis/drive", () => ({ drive: vi.fn(() => ({ files: h.files })) }))

const { listProjectLinks, linkProjectDoc, unlinkProjectDoc, isDocInProject } = await import("./google-doc-links.service.js")

const auth = {} as OAuth2Client
const link = (over: Record<string, unknown>) => ({
  _id: `l-${String(over.fileId)}`,
  projectId: "p1",
  userId: "u1",
  kind: "export",
  title: "SRS",
  webViewLink: "https://docs.google.com/document/d/x/edit",
  source: "draft",
  lang: "vi",
  baselineId: null,
  exportedAt: new Date("2026-11-10"),
  exportedSpineVersion: 12,
  driveVersion: "5",
  folderId: "folder-p1",
  folderPath: "FlintFlow / Đặt lịch",
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  h.links.length = 0
})

describe("listProjectLinks", () => {
  it("mọi thành viên thấy Doc của dự án, kèm chủ sở hữu, isMine, thư mục và nhãn cũ", async () => {
    h.links.push(
      link({ fileId: "mine-fresh", exportedAt: new Date("2026-11-12") }),
      link({ fileId: "mine-stale", exportedSpineVersion: 10, exportedAt: new Date("2026-11-11") }),
      link({ fileId: "theirs", userId: "u2", kind: "linked", source: null, lang: null, exportedSpineVersion: null, folderId: null, folderPath: null }),
      link({ fileId: "baseline", source: "baseline", baselineId: "BL1", exportedSpineVersion: 1, exportedAt: new Date("2026-11-01") }),
      link({ fileId: "other-project", projectId: "p2" })
    )
    const result = await listProjectLinks("p1", "u1")

    expect(result.map((l) => [l.fileId, l.isMine, l.stale])).toEqual([
      ["mine-fresh", true, false],
      ["mine-stale", true, true],
      ["theirs", false, false],
      ["baseline", true, false]
    ])
    expect(result[0]).toMatchObject({
      kind: "export",
      owner: { id: "u1", name: "An", email: "an@example.com" },
      folder: { id: "folder-p1", path: "FlintFlow / Đặt lịch", url: "https://drive.google.com/drive/folders/folder-p1" }
    })
    expect(result[2]).toMatchObject({ kind: "linked", owner: { id: "u2", name: "Bình" }, folder: null })
  })

  it("bản ghi cũ chưa có kind ⇒ coi là export", async () => {
    h.links.push(link({ fileId: "legacy", kind: undefined, exportedSpineVersion: undefined }))
    const [view] = await listProjectLinks("p1", "u1")
    expect(view).toMatchObject({ kind: "export", stale: false })
  })
})

describe("linkProjectDoc", () => {
  it("Google Doc chọn từ Picker ⇒ lưu link kind linked của user", async () => {
    h.files.get.mockResolvedValue({ data: { id: "client-doc", name: "SRS khách", mimeType: "application/vnd.google-apps.document", trashed: false, webViewLink: "https://docs.google.com/document/d/client-doc/edit" } })
    const view = await linkProjectDoc(auth, "p1", "u1", "client-doc")

    expect(view).toMatchObject({ fileId: "client-doc", title: "SRS khách", kind: "linked", isMine: true, stale: false, folder: null })
    expect(h.links[0]).toMatchObject({ projectId: "p1", userId: "u1", kind: "linked", fileId: "client-doc" })
  })

  it("file .docx ⇒ 400 GOOGLE_DOC_UNSUPPORTED, không lưu", async () => {
    h.files.get.mockResolvedValue({ data: { id: "w", name: "SRS.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", trashed: false } })
    await expect(linkProjectDoc(auth, "p1", "u1", "w")).rejects.toMatchObject({ statusCode: 400, code: "GOOGLE_DOC_UNSUPPORTED" })
    expect(h.links).toHaveLength(0)
  })

  it("Doc đã thuộc dự án ⇒ trả bản đang có, không thêm link", async () => {
    h.links.push(link({ fileId: "doc-1" }))
    h.files.get.mockResolvedValue({ data: { id: "doc-1", name: "SRS", mimeType: "application/vnd.google-apps.document", trashed: false } })
    const view = await linkProjectDoc(auth, "p1", "u2", "doc-1")
    expect(view).toMatchObject({ fileId: "doc-1", kind: "export", isMine: false })
    expect(h.links).toHaveLength(1)
  })

  it("Drive 403 ⇒ GOOGLE_FILE_FORBIDDEN", async () => {
    h.files.get.mockRejectedValue(Object.assign(new Error("forbidden"), { response: { status: 403 } }))
    await expect(linkProjectDoc(auth, "p1", "u1", "x")).rejects.toMatchObject({ statusCode: 403, code: "GOOGLE_FILE_FORBIDDEN" })
  })
})

describe("unlinkProjectDoc / isDocInProject", () => {
  it("bỏ liên kết chỉ xoá bản ghi của dự án đó; Doc không thuộc dự án ⇒ 404", async () => {
    h.links.push(link({ fileId: "doc-1" }), link({ fileId: "doc-1", projectId: "p2" }))
    expect(await isDocInProject("p1", "doc-1")).toBe(true)

    expect(await unlinkProjectDoc("p1", "doc-1")).toEqual({ removed: 1 })
    expect(await isDocInProject("p1", "doc-1")).toBe(false)
    expect(await isDocInProject("p2", "doc-1")).toBe(true)
    await expect(unlinkProjectDoc("p1", "doc-1")).rejects.toMatchObject({ statusCode: 404, code: "GOOGLE_DOC_NOT_IN_PROJECT" })
  })
})
