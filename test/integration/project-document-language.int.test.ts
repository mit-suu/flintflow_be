/**
 * FLF-265 phase 1: ngôn ngữ tài liệu là thuộc tính dự án — `POST /projects` lưu `documentLanguage` (mode 2: body ⇒
 * `User.locale` ⇒ en; mode 1 bỏ qua), `PATCH /projects/:id/document-language` chỉ Lead/Analyst, mode 1 ⇒ 409.
 * Qua HTTP trên Mongo thật.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

const join = async (orgId: string, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId })
}

let seeded: SeededFixture

beforeEach(async () => {
  seeded = await seedFixture("minimal")
})

const patchLanguage = (projectId: string, token: string, body: unknown) =>
  request(app).patch(`/api/v1/projects/${projectId}/document-language`).set(bearer(token)).send(body as object)

describe("POST /projects — documentLanguage", () => {
  it("body gửi vi ⇒ lưu vi, GET /projects/:id trả lại field", async () => {
    const created = await request(app).post("/api/v1/projects").set(bearer(seeded.token)).send({ name: "Lumen", documentLanguage: "vi" })
    expect(created.status).toBe(201)
    expect(created.body.data.documentLanguage).toBe("vi")

    const one = await request(app).get(`/api/v1/projects/${created.body.data._id}`).set(bearer(seeded.token))
    expect(one.body.data.documentLanguage).toBe("vi")
  })

  it("thiếu ⇒ lấy User.locale; tài khoản chưa chọn ⇒ en", async () => {
    const fallback = await request(app).post("/api/v1/projects").set(bearer(seeded.token)).send({ name: "Không chọn" })
    expect(fallback.body.data.documentLanguage).toBe("en")

    await User.updateOne({ _id: seeded.userId }, { locale: "vi" })
    const fromAccount = await request(app).post("/api/v1/projects").set(bearer(seeded.token)).send({ name: "Theo tài khoản" })
    expect(fromAccount.status).toBe(201)
    expect(fromAccount.body.data.documentLanguage).toBe("vi")
  })

  it("giá trị lạ ⇒ 400 VALIDATION_ERROR", async () => {
    const res = await request(app).post("/api/v1/projects").set(bearer(seeded.token)).send({ name: "Lumen", documentLanguage: "fr" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("mode import bỏ qua giá trị gửi lên, không lưu field", async () => {
    const created = await request(app).post("/api/v1/projects").set(bearer(seeded.token)).send({ name: "SRS có sẵn", mode: "import", documentLanguage: "vi" })
    expect(created.status).toBe(201)
    expect(created.body.data.documentLanguage).toBeUndefined()

    const raw = await Project.findById(created.body.data._id).lean()
    expect(raw).not.toHaveProperty("documentLanguage")
  })
})

describe("PATCH /projects/:id/document-language", () => {
  it("Lead và Analyst đổi được ⇒ 200, GET trả giá trị mới", async () => {
    const lead = await patchLanguage(seeded.projectId, seeded.token, { documentLanguage: "vi" })
    expect(lead.status).toBe(200)
    expect(lead.body.data.documentLanguage).toBe("vi")

    const analyst = await join(seeded.orgId, "analyst@flintflow.test", "analyst")
    const byAnalyst = await patchLanguage(seeded.projectId, analyst, { documentLanguage: "en" })
    expect(byAnalyst.status).toBe(200)

    const one = await request(app).get(`/api/v1/projects/${seeded.projectId}`).set(bearer(seeded.token))
    expect(one.body.data.documentLanguage).toBe("en")
  })

  it("Viewer ⇒ 403 ORG_ROLE_FORBIDDEN, không ghi", async () => {
    const viewer = await join(seeded.orgId, "viewer@flintflow.test", "viewer")
    const res = await patchLanguage(seeded.projectId, viewer, { documentLanguage: "vi" })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect((await Project.findById(seeded.projectId).lean())?.documentLanguage).toBeUndefined()
  })

  it("giá trị lạ, thiếu field hoặc key lạ ⇒ 400 VALIDATION_ERROR", async () => {
    for (const body of [{ documentLanguage: "fr" }, {}, { documentLanguage: "vi", name: "đổi tên lén" }]) {
      const res = await patchLanguage(seeded.projectId, seeded.token, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
    }
    const raw = await Project.findById(seeded.projectId).lean()
    expect(raw?.documentLanguage).toBeUndefined()
    expect(raw?.name).toBe("FlintFlow (Fixture Minimal)")
  })

  it("dự án mode import ⇒ 409 DOCUMENT_LANGUAGE_LOCKED", async () => {
    const created = await request(app).post("/api/v1/projects").set(bearer(seeded.token)).send({ name: "SRS có sẵn", mode: "import" })
    const res = await patchLanguage(created.body.data._id, seeded.token, { documentLanguage: "vi" })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("DOCUMENT_LANGUAGE_LOCKED")
    expect((await Project.findById(created.body.data._id).lean())?.documentLanguage).toBeUndefined()
  })

  it("dự án của org khác ⇒ 404 PROJECT_NOT_FOUND; id sai định dạng ⇒ 404", async () => {
    const other = await seedFixture("minimal")
    const foreign = await patchLanguage(other.projectId, seeded.token, { documentLanguage: "vi" })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe("PROJECT_NOT_FOUND")
    expect((await Project.findById(other.projectId).lean())?.documentLanguage).toBeUndefined()

    const bad = await patchLanguage("khong-phai-id", seeded.token, { documentLanguage: "vi" })
    expect(bad.status).toBe(404)
  })
})

describe("dự án cũ không có field", () => {
  it("vẫn qua validate của model và đọc được qua API, field vắng mặt", async () => {
    const legacy = await Project.findById(seeded.projectId)
    expect(legacy?.documentLanguage).toBeUndefined()
    expect(legacy?.validateSync()).toBeUndefined()

    const one = await request(app).get(`/api/v1/projects/${seeded.projectId}`).set(bearer(seeded.token))
    expect(one.status).toBe(200)
    expect(one.body.data.documentLanguage).toBeUndefined()

    const list = await request(app).get("/api/v1/projects").set(bearer(seeded.token))
    expect(list.status).toBe(200)
    expect(list.body.data[0].documentLanguage).toBeUndefined()
  })
})
