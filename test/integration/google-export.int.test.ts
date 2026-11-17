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
  files: { get: vi.fn(), create: vi.fn(), update: vi.fn() }
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
const driveFile = (id: string) => ({ data: { id, name: "Doc", webViewLink: `https://docs.google.com/document/d/${id}/edit` } })

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
})

describe("POST /projects/:id/export/google-docs", () => {
  let seeded: SeededFixture

  beforeEach(async () => {
    seeded = await seedFixture("minimal")
  })

  it("tạo Google Doc từ đúng file .docx của /export/word, rồi cập nhật cùng file; links liệt kê đúng một file", async () => {
    await connectGoogle(seeded.token)
    google.files.create.mockResolvedValue(driveFile("doc-1"))

    const created = await exportDocs(seeded, seeded.token, "source=draft")
    expect(created.status).toBe(200)
    expect(created.body.data).toEqual({
      fileId: "doc-1",
      webViewLink: "https://docs.google.com/document/d/doc-1/edit",
      title: "Doc",
      mode: "new",
      recreated: false
    })
    const createCall = google.files.create.mock.calls[0][0]
    expect(createCall.requestBody.mimeType).toBe("application/vnd.google-apps.document")
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

    google.files.get.mockResolvedValue({ data: { id: "doc-1", trashed: false } })
    google.files.update.mockResolvedValue(driveFile("doc-1"))
    const updated = await exportDocs(seeded, seeded.token, "source=draft", { mode: "update" })
    expect(updated.status).toBe(200)
    expect(updated.body.data).toMatchObject({ fileId: "doc-1", mode: "update", recreated: false })
    expect(google.files.update.mock.calls[0][0].fileId).toBe("doc-1")

    const links = await request(app).get(`/api/v1/projects/${seeded.projectId}/google-docs/links`).set(as(seeded.token))
    expect(links.status).toBe(200)
    expect(links.body.data).toHaveLength(1)
    expect(links.body.data[0]).toMatchObject({ fileId: "doc-1", source: "draft", baselineId: null })
    expect(links.body.data[0].lang).toMatch(/^(vi|en)$/)
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

  it("Viewer xuất bản nháp ⇒ 403 như /export/word (không phải lỗi Google); xem được links của mình", async () => {
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
