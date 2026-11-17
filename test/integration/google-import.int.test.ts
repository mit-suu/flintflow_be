/**
 * Nhập từ Google Docs (contract #46) qua HTTP trên Mongo thật: file chọn trong Picker đi đúng luồng upload có sẵn
 * (`uploadImport`, preflight, tách block) — cùng trạng thái như tải .docx từ máy. Google (OAuth + Drive) được mock.
 */
import crypto from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { env } from "../../src/config/env.js"
import { makeSrsDocx } from "../../src/modules/import/testing/srs-fixture.js"
import { importStateResponseSchema } from "../../src/modules/import/import.dto.js"
import { createMode1Project } from "../helpers/mode1.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
const GDOC = "application/vnd.google-apps.document"

const google = vi.hoisted(() => ({
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
  getAccessToken: vi.fn(),
  files: { get: vi.fn(), export: vi.fn() }
}))

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(function OAuth2Client() {
    return {
      getToken: google.getToken,
      verifyIdToken: google.verifyIdToken,
      revokeToken: vi.fn(),
      credentials: {},
      setCredentials() {},
      getAccessToken: google.getAccessToken
    }
  })
}))
vi.mock("@googleapis/drive", () => ({ drive: vi.fn(() => ({ files: google.files })) }))

const as = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })
const toArrayBuffer = (buf: Buffer) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)

const connectGoogle = async (seeded: SeededFixture) => {
  google.getToken.mockResolvedValue({ tokens: { scope: `openid email ${DRIVE_SCOPE}`, refresh_token: "refresh", id_token: "id" } })
  google.verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "sub", email: "owner@gmail.com" }) })
  expect((await request(app).post("/api/v1/integrations/google/connect").set(as(seeded)).send({ code: "c" })).status).toBe(200)
}

const importGoogle = (seeded: SeededFixture, projectId: string, body: object) =>
  request(app).post(`/api/v1/projects/${projectId}/import/google-docs`).set(as(seeded)).send(body)

beforeEach(() => {
  vi.clearAllMocks()
  env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com"
  env.GOOGLE_CLIENT_SECRET = "test-client-secret"
  env.GOOGLE_TOKEN_ENC_KEY = crypto.randomBytes(32).toString("base64")
  google.getAccessToken.mockResolvedValue({ token: "access" })
})

describe("POST /projects/:id/import/google-docs", () => {
  it("Google Doc ⇒ xuất .docx rồi đi đúng luồng upload: cùng trạng thái như tải từ máy, tên file <tên>.docx", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    await connectGoogle(seeded)
    google.files.get.mockResolvedValue({ data: { id: "doc-1", name: "SRS Bán Vé", mimeType: GDOC, trashed: false } })
    google.files.export.mockResolvedValue({ data: toArrayBuffer(await makeSrsDocx()) })

    const res = await importGoogle(seeded, projectId, { fileId: "doc-1" })
    expect(res.status).toBe(201)
    const imported = importStateResponseSchema.parse(res.body.data).import
    expect(imported).toMatchObject({ original_name: "SRS Bán Vé.docx", status: "extracting", stamp: null })
    expect(google.files.export.mock.calls[0][0]).toMatchObject({ fileId: "doc-1" })

    // Đối chiếu: upload chính file đó từ máy ra cùng trạng thái
    const other = await seedFixture("minimal")
    const otherProject = await createMode1Project(other)
    const upload = await request(app)
      .post(`/api/v1/projects/${otherProject}/import`)
      .set(as(other))
      .attach("file", await makeSrsDocx(), "SRS Bán Vé.docx")
    expect(importStateResponseSchema.parse(upload.body.data).import.status).toBe(imported.status)
  })

  it("chưa nối Google ⇒ 401 GOOGLE_RECONNECT_REQUIRED, không gọi Drive", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    const res = await importGoogle(seeded, projectId, { fileId: "doc-1" })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe("GOOGLE_RECONNECT_REQUIRED")
    expect(google.files.get).not.toHaveBeenCalled()
  })

  it("file không phải Google Doc / .docx ⇒ 400 GOOGLE_FILE_UNSUPPORTED; fileId sai dạng ⇒ 400 VALIDATION_ERROR", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createMode1Project(seeded)
    await connectGoogle(seeded)
    google.files.get.mockResolvedValue({ data: { id: "pdf-1", name: "scan", mimeType: "application/pdf", trashed: false } })

    const pdf = await importGoogle(seeded, projectId, { fileId: "pdf-1" })
    expect(pdf.status).toBe(400)
    expect(pdf.body.error.code).toBe("GOOGLE_FILE_UNSUPPORTED")

    const bad = await importGoogle(seeded, projectId, { fileId: "../etc" })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("dự án không phải mode import ⇒ 409 PROJECT_MODE_MISMATCH như POST /import", async () => {
    const seeded = await seedFixture("minimal")
    await connectGoogle(seeded)
    const res = await importGoogle(seeded, seeded.projectId, { fileId: "doc-1" })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("PROJECT_MODE_MISMATCH")
    expect(google.files.get).not.toHaveBeenCalled()
  })
})
