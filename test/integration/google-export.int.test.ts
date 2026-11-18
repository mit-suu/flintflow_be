/**
 * Xuất sang Google Docs (contract #44, #45) qua HTTP trên Mongo thật: đúng file .docx của /export/word được upload lên
 * Drive, xuất lại ở chế độ cập nhật ghi đè cùng file, quyền giống /export/word. Google (OAuth + Drive) được mock.
 */
import crypto from "node:crypto"
import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { env } from "../../src/config/env.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"

const google = vi.hoisted(() => ({
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
  revokeToken: vi.fn(),
  getAccessToken: vi.fn(),
  /** Thư mục app đã tạo: "key=value" của appProperties → { id, name }. */
  folders: new Map<string, { id: string; name: string }>(),
  files: { get: vi.fn(), create: vi.fn(), update: vi.fn(), list: vi.fn() }
}))

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(function OAuth2Client() {
    return {
      getToken: google.getToken,
      verifyIdToken: google.verifyIdToken,
      revokeToken: google.revokeToken,
      credentials: {},
      setCredentials() {},
      getAccessToken: google.getAccessToken
    }
  })
}))
vi.mock("@googleapis/drive", () => ({ drive: vi.fn(() => ({ files: google.files })) }))

const as = (token: string) => ({ Authorization: `Bearer ${token}` })
const FOLDER_MIME = "application/vnd.google-apps.folder"
const driveFile = (id: string, version = "10") => ({
  data: { id, name: "Doc", webViewLink: `https://docs.google.com/document/d/${id}/edit`, version, parents: ["folder-project"] }
})

/** `files.create` tạo thư mục (ghi vào `google.folders`) hoặc trả lần lượt các file Google Doc. */
const arrangeCreate = (...docs: ReturnType<typeof driveFile>[]) =>
  google.files.create.mockImplementation(async ({ requestBody }: { requestBody: { name: string; mimeType: string; appProperties?: Record<string, string> } }) => {
    if (requestBody.mimeType === FOLDER_MIME) {
      const [key, value] = Object.entries(requestBody.appProperties ?? {})[0]
      const folder = { id: key === "flintflowRoot" ? "folder-root" : "folder-project", name: requestBody.name }
      google.folders.set(`${key}=${value}`, folder)
      return { data: folder }
    }
    const next = docs.shift()
    if (!next) throw new Error("files.create ngoài kịch bản")
    return next
  })
const docCreates = () => google.files.create.mock.calls.map(([arg]) => arg).filter((arg) => arg.requestBody.mimeType !== FOLDER_MIME)

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const connectGoogle = async (token: string) => {
  google.getToken.mockResolvedValue({ tokens: { scope: `openid email ${DRIVE_SCOPE}`, refresh_token: "refresh", id_token: "id" } })
  google.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "sub", email: "owner@gmail.com" }) })
  const res = await request(app).post("/api/v1/integrations/google/connect").set(as(token)).send({ code: "code" })
  expect(res.status).toBe(200)
}

const exportDocs = (seeded: { projectId: string }, token: string, query: string, body: object = {}) =>
  request(app).post(`/api/v1/projects/${seeded.projectId}/export/google-docs?${query}`).set(as(token)).send(body)

beforeEach(() => {
  vi.clearAllMocks()
  env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com"
  env.GOOGLE_CLIENT_SECRET = "test-client-secret"
  env.GOOGLE_TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64")
  google.getAccessToken.mockResolvedValue({ token: "access" })
  google.folders.clear()
  google.files.list.mockImplementation(async ({ q }: { q: string }) => {
    const m = /key='(\w+)' and value='(\w+)'/.exec(q)
    const found = m ? google.folders.get(`${m[1]}=${m[2]}`) : undefined
    return { data: { files: found ? [found] : [] } }
  })
})

describe("POST /projects/:id/export/google-docs", () => {
  let seeded: SeededFixture

  beforeEach(async () => {
    seeded = await seedFixture("minimal")
  })

  it("tạo Google Doc trong FlintFlow / <dự án> từ đúng file .docx của /export/word, rồi cập nhật cùng file; links liệt kê đúng một file", async () => {
    await connectGoogle(seeded.token)
    arrangeCreate(driveFile("doc-1"))

    const created = await exportDocs(seeded, seeded.token, "source=draft")
    expect(created.status).toBe(200)
    const projectFolderName = google.folders.get(`flintflowProjectId=${seeded.projectId}`)!.name
    expect(created.body.data).toEqual({
      fileId: "doc-1",
      webViewLink: "https://docs.google.com/document/d/doc-1/edit",
      title: "Doc",
      mode: "new",
      recreated: false,
      folder: { id: "folder-project", path: `FlintFlow / ${projectFolderName}`, url: "https://drive.google.com/drive/folders/folder-project" }
    })
    const [createCall] = docCreates()
    expect(createCall.requestBody.mimeType).toBe("application/vnd.google-apps.document")
    expect(createCall.requestBody.parents).toEqual(["folder-project"])
    // Cùng bytes với file Word người dùng tải được
    const uploaded = await readAll(createCall.media.body)
    const word = await request(app)
      .get(`/api/v1/projects/${seeded.projectId}/export/word?source=draft`)
      .set(as(seeded.token))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => done(null, Buffer.concat(chunks)))
      })
    expect(uploaded.subarray(0, 2).toString()).toBe("PK")
    expect(uploaded.length).toBeGreaterThan(1000)
    expect(createCall.requestBody.name).toBe(
      decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(word.headers["content-disposition"])![1]).replace(/\.docx$/, "")
    )

    google.files.get.mockResolvedValue({ data: { id: "doc-1", trashed: false, version: "10", parents: ["folder-project"] } })
    google.files.update.mockResolvedValue(driveFile("doc-1", "11"))
    const updated = await exportDocs(seeded, seeded.token, "source=draft", { mode: "update" })
    expect(updated.status).toBe(200)
    expect(updated.body.data).toMatchObject({ fileId: "doc-1", mode: "update", recreated: false, folder: { id: "folder-project" } })
    expect(google.files.update.mock.calls.find(([arg]) => arg.fileId === "doc-1")).toBeDefined()

    const links = await request(app).get(`/api/v1/projects/${seeded.projectId}/google-docs/links`).set(as(seeded.token))
    expect(links.status).toBe(200)
    expect(links.body.data).toHaveLength(1)
    expect(links.body.data[0]).toMatchObject({
      fileId: "doc-1",
      kind: "export",
      source: "draft",
      baselineId: null,
      isMine: true,
      stale: false,
      owner: { id: seeded.userId },
      folder: { id: "folder-project" }
    })
    expect(links.body.data[0].lang).toMatch(/^(vi|en)$/)
  })

  it("Doc đã bị sửa trong Google Docs sau lần xuất ⇒ 409 GOOGLE_DOC_MODIFIED, không ghi; gửi lại force ⇒ ghi đè", async () => {
    await connectGoogle(seeded.token)
    arrangeCreate(driveFile("doc-1", "10"))
    expect((await exportDocs(seeded, seeded.token, "source=draft")).status).toBe(200)

    google.files.get.mockResolvedValue({ data: { id: "doc-1", trashed: false, version: "14", parents: ["folder-project"] } })
    const blocked = await exportDocs(seeded, seeded.token, "source=draft", { mode: "update" })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe("GOOGLE_DOC_MODIFIED")
    expect(google.files.update).not.toHaveBeenCalled()

    google.files.update.mockResolvedValue(driveFile("doc-1", "15"))
    const forced = await exportDocs(seeded, seeded.token, "source=draft", { mode: "update", force: true })
    expect(forced.status).toBe(200)
    expect(forced.body.data).toMatchObject({ fileId: "doc-1", mode: "update" })
  })

  it("chưa nối Google ⇒ 401 GOOGLE_RECONNECT_REQUIRED, không gọi Drive", async () => {
    const res = await exportDocs(seeded, seeded.token, "source=draft")
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe("GOOGLE_RECONNECT_REQUIRED")
    expect(google.files.create).not.toHaveBeenCalled()
  })

  it("mode sai ⇒ 400 VALIDATION_ERROR", async () => {
    const res = await exportDocs(seeded, seeded.token, "source=draft", { mode: "overwrite" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("Drive hết dung lượng ⇒ 503 GOOGLE_DRIVE_QUOTA_EXCEEDED", async () => {
    await connectGoogle(seeded.token)
    google.folders.set("flintflowRoot=1", { id: "folder-root", name: "FlintFlow" })
    google.folders.set(`flintflowProjectId=${seeded.projectId}`, { id: "folder-project", name: "x" })
    google.files.update.mockResolvedValue({ data: {} })
    google.files.create.mockRejectedValue(
      Object.assign(new Error("quota"), { response: { status: 403, data: { error: { errors: [{ reason: "storageQuotaExceeded" }] } } } })
    )
    const res = await exportDocs(seeded, seeded.token, "source=draft")
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe("GOOGLE_DRIVE_QUOTA_EXCEEDED")
  })

  it("tắt tích hợp ⇒ 503 GOOGLE_INTEGRATION_DISABLED ở cả xuất lẫn links", async () => {
    env.GOOGLE_CLIENT_SECRET = ""
    expect((await exportDocs(seeded, seeded.token, "source=draft")).body.error.code).toBe("GOOGLE_INTEGRATION_DISABLED")
    const links = await request(app).get(`/api/v1/projects/${seeded.projectId}/google-docs/links`).set(as(seeded.token))
    expect(links.status).toBe(503)
  })

  it("Viewer xuất bản nháp ⇒ 403 như /export/word (không phải lỗi Google); xem được links của dự án", async () => {
    const viewer = await User.create({ email: "viewer-gd@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: seeded.orgId, userId: viewer._id, role: "viewer" })
    const viewerToken = await authAs({ _id: viewer._id, email: "viewer-gd@flintflow.test", orgId: seeded.orgId })

    const res = await exportDocs(seeded, viewerToken, "source=draft")
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")

    const links = await request(app).get(`/api/v1/projects/${seeded.projectId}/google-docs/links`).set(as(viewerToken))
    expect(links.status).toBe(200)
    expect(links.body.data).toEqual([])
  })

  it("người ngoài org ⇒ 404 ở cả xuất lẫn links", async () => {
    const other = await seedFixture("minimal")
    expect((await exportDocs(seeded, other.token, "source=draft")).status).toBe(404)
    expect((await request(app).get(`/api/v1/projects/${seeded.projectId}/google-docs/links`).set(as(other.token))).status).toBe(404)
  })
})

describe("POST / DELETE /projects/:id/google-docs/links — liên kết Google Doc vào dự án", () => {
  let seeded: SeededFixture
  const linksUrl = () => `/api/v1/projects/${seeded.projectId}/google-docs/links`

  beforeEach(async () => {
    seeded = await seedFixture("minimal")
  })

  it("liên kết Google Doc ⇒ thành viên khác thấy (isMine false); xuất cập nhật không ghi đè Doc liên kết; bỏ liên kết ⇒ biến mất", async () => {
    await connectGoogle(seeded.token)
    google.files.get.mockResolvedValue({
      data: { id: "client-doc", name: "SRS khách", mimeType: "application/vnd.google-apps.document", trashed: false, webViewLink: "https://docs.google.com/document/d/client-doc/edit" }
    })
    const linked = await request(app).post(linksUrl()).set(as(seeded.token)).send({ fileId: "client-doc" })
    expect(linked.status).toBe(200)
    expect(linked.body.data).toMatchObject({ fileId: "client-doc", title: "SRS khách", kind: "linked", isMine: true })

    const teammate = await User.create({ email: "analyst-link@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: seeded.orgId, userId: teammate._id, role: "analyst" })
    const teammateToken = await authAs({ _id: teammate._id, email: "analyst-link@flintflow.test", orgId: seeded.orgId })
    const seen = await request(app).get(linksUrl()).set(as(teammateToken))
    expect(seen.body.data).toEqual([expect.objectContaining({ fileId: "client-doc", isMine: false, owner: expect.objectContaining({ id: seeded.userId }) })])

    // Chế độ cập nhật không bao giờ nhắm vào Doc liên kết ⇒ tạo Doc mới
    arrangeCreate(driveFile("doc-export"))
    const exported = await exportDocs(seeded, seeded.token, "source=draft", { mode: "update" })
    expect(exported.body.data).toMatchObject({ fileId: "doc-export", mode: "new" })
    expect(google.files.update.mock.calls.some(([arg]) => arg.fileId === "client-doc")).toBe(false)

    const removed = await request(app).delete(`${linksUrl()}/client-doc`).set(as(seeded.token))
    expect(removed.status).toBe(200)
    expect(removed.body.data).toEqual({ removed: 1 })
    const after = await request(app).get(linksUrl()).set(as(seeded.token))
    expect(after.body.data.map((l: { fileId: string }) => l.fileId)).toEqual(["doc-export"])
    expect((await request(app).delete(`${linksUrl()}/client-doc`).set(as(seeded.token))).body.error.code).toBe("GOOGLE_DOC_NOT_IN_PROJECT")
  })

  it("file .docx ⇒ 400 GOOGLE_DOC_UNSUPPORTED; Viewer ⇒ 403; fileId sai ⇒ 400", async () => {
    await connectGoogle(seeded.token)
    google.files.get.mockResolvedValue({ data: { id: "w", name: "SRS.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", trashed: false } })
    const docx = await request(app).post(linksUrl()).set(as(seeded.token)).send({ fileId: "w" })
    expect(docx.status).toBe(400)
    expect(docx.body.error.code).toBe("GOOGLE_DOC_UNSUPPORTED")

    expect((await request(app).post(linksUrl()).set(as(seeded.token)).send({ fileId: "../x" })).status).toBe(400)

    const viewer = await User.create({ email: "viewer-link@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: seeded.orgId, userId: viewer._id, role: "viewer" })
    const viewerToken = await authAs({ _id: viewer._id, email: "viewer-link@flintflow.test", orgId: seeded.orgId })
    expect((await request(app).post(linksUrl()).set(as(viewerToken)).send({ fileId: "client-doc" })).status).toBe(403)
    expect((await request(app).delete(`${linksUrl()}/client-doc`).set(as(viewerToken))).status).toBe(403)
  })
})
