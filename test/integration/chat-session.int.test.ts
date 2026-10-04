/**
 * FLF-244 — chat session qua HTTP thật: vai trò (Viewer không tạo/xoá/nhắn), phiên chính không xoá được, phiên phụ
 * không chạy được giai đoạn, id sai định dạng ⇒ 404, danh sách phiên chỉ kèm tin cuối, và hai request tạo phiên đầu
 * cùng lúc vẫn ra đúng một phiên pipeline (unique index thật).
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { ChatSession } from "../../src/modules/project/chat-session.model.js"
import { authAs, seedFixture } from "../setup.js"

const joinOrg = async (orgId: string, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId })
}

const bearer = (token: string) => ({ Authorization: "Bearer " + token })
const chats = (projectId: string) => `/api/v1/projects/${projectId}/chats`

describe("FLF-244 chat session — vai trò", () => {
  it("Viewer đọc được danh sách phiên nhưng không tạo, không nhắn, không xoá", async () => {
    const owner = await seedFixture("minimal")
    const viewer = await joinOrg(owner.orgId, "viewer@flintflow.test", "viewer")

    const list = await request(app).get(chats(owner.projectId)).set(bearer(viewer))
    expect(list.status).toBe(200)

    const create = await request(app).post(chats(owner.projectId)).set(bearer(viewer))
    expect(create.status).toBe(403)
    expect(create.body.error.code).toBe("ORG_ROLE_FORBIDDEN")

    for (const suffix of ["/messages", "/messages/stream"]) {
      const send = await request(app)
        .post(`${chats(owner.projectId)}/${owner.sessionId}${suffix}`)
        .set(bearer(viewer))
        .send({ content: "Tài liệu thiếu gì?", step: "chat" })
      expect(send.status).toBe(403)
      expect(send.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    }

    const del = await request(app).delete(`${chats(owner.projectId)}/${owner.sessionId}`).set(bearer(viewer))
    expect(del.status).toBe(403)
  })

  it("Analyst tạo được phiên phụ (is_pipeline=false)", async () => {
    const owner = await seedFixture("minimal")
    const analyst = await joinOrg(owner.orgId, "analyst@flintflow.test", "analyst")

    const res = await request(app).post(chats(owner.projectId)).set(bearer(analyst))
    expect(res.status).toBe(201)
    expect(res.body.data.is_pipeline).toBe(false)
  })
})

describe("FLF-244 chat session — phiên chính và phiên phụ", () => {
  it("phiên chính không xoá được (409 PIPELINE_SESSION_LOCKED); phiên phụ xoá được", async () => {
    const owner = await seedFixture("minimal")
    const extra = await request(app).post(chats(owner.projectId)).set(bearer(owner.token))

    const locked = await request(app).delete(`${chats(owner.projectId)}/${owner.sessionId}`).set(bearer(owner.token))
    expect(locked.status).toBe(409)
    expect(locked.body.error.code).toBe("PIPELINE_SESSION_LOCKED")
    expect(await ChatSession.exists({ _id: owner.sessionId, is_pipeline: true })).not.toBeNull()

    const removed = await request(app).delete(`${chats(owner.projectId)}/${extra.body.data._id}`).set(bearer(owner.token))
    expect(removed.status).toBe(200)
  })

  it("/phases/:phase/run từ phiên phụ ⇒ 403 NOT_PIPELINE_SESSION, không ghi gì vào phiên", async () => {
    const owner = await seedFixture("minimal")
    const extra = await request(app).post(chats(owner.projectId)).set(bearer(owner.token))
    const extraId = extra.body.data._id as string

    const res = await request(app)
      .post(`/api/v1/projects/${owner.projectId}/phases/B-0/run`)
      .set(bearer(owner.token))
      .send({ session_id: extraId, base_version: owner.spineVersion })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("NOT_PIPELINE_SESSION")
    const after = await ChatSession.findById(extraId).lean()
    expect(after?.messages).toHaveLength(0)
  })

  it("GET /chats: mỗi phiên chỉ kèm tin cuối; GET /chats/:id trả đủ", async () => {
    const owner = await seedFixture("minimal")
    await ChatSession.updateOne(
      { _id: owner.sessionId },
      { $push: { messages: { $each: [{ role: "user", content: "một", step: "chat" }, { role: "ai", content: "hai", step: "chat" }] } } }
    )

    const list = await request(app).get(chats(owner.projectId)).set(bearer(owner.token))
    const pipeline = list.body.data.find((s: { _id: string }) => s._id === owner.sessionId)
    expect(pipeline.messages.map((m: { content: string }) => m.content)).toEqual(["hai"])
    expect(pipeline).not.toHaveProperty("isActive")

    const full = await request(app).get(`${chats(owner.projectId)}/${owner.sessionId}`).set(bearer(owner.token))
    expect(full.body.data.messages).toHaveLength(2)
  })

  it("hai request tạo phiên đầu cùng lúc ⇒ đúng một phiên pipeline", async () => {
    const owner = await seedFixture("minimal")
    await ChatSession.deleteMany({ projectId: owner.projectId })

    const results = await Promise.all([
      request(app).post(chats(owner.projectId)).set(bearer(owner.token)),
      request(app).post(chats(owner.projectId)).set(bearer(owner.token))
    ])
    expect(results.map((r) => r.status)).toEqual([201, 201])
    expect(await ChatSession.countDocuments({ projectId: owner.projectId, is_pipeline: true })).toBe(1)
    expect(await ChatSession.countDocuments({ projectId: owner.projectId })).toBe(2)
  })
})

describe("FLF-244 chat session — id sai định dạng", () => {
  it("projectId không phải ObjectId ⇒ 404 PROJECT_NOT_FOUND (không phải 500)", async () => {
    const owner = await seedFixture("minimal")
    const res = await request(app).get(chats("abc")).set(bearer(owner.token))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
  })

  it("chatId không phải ObjectId ⇒ 404 CHAT_SESSION_NOT_FOUND", async () => {
    const owner = await seedFixture("minimal")
    const res = await request(app).get(`${chats(owner.projectId)}/xyz`).set(bearer(owner.token))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("CHAT_SESSION_NOT_FOUND")
  })
})
