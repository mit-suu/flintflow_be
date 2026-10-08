/**
 * Prompt/response của lượt gọi model: chỉ admin đọc được, vì prompt mang nguyên văn điều người dùng nhập.
 * Không còn bản ghi (quá hạn giữ, hoặc lượt chạy trước khi bật việc lưu) thì nói rõ là 404, không trả rỗng.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import mongoose from "mongoose"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { AiActionPayload } from "../../src/modules/admin/ai-action-payload.model.js"
import { authAs } from "../setup.js"

const seedPayload = async (logId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId) =>
  AiActionPayload.create({
    logId,
    projectId: new mongoose.Types.ObjectId(),
    userId,
    actionType: "DRAFT_TO_OPS",
    prompt: "Bạn là BA. projection: {...}",
    response: '{"ops":[],"notes":"xong"}',
    // Dài hơn chuỗi lưu ⇒ bản đang xem đã bị cắt giữa
    promptChars: 52_000,
    responseChars: 24
  })

describe("GET /admin/ai-logs/:logId/payload", () => {
  it("admin đọc được prompt + response gốc, kèm độ dài thật để biết bản này đã bị cắt", async () => {
    const adminUser = await User.create({ email: "admin@flintflow.test", password: "test-password-123", role: "admin", emailVerified: true })
    const admin = await authAs({ _id: adminUser._id, email: adminUser.email, role: "admin" })
    const logId = new mongoose.Types.ObjectId()
    await seedPayload(logId, adminUser._id)

    const res = await request(app).get(`/api/v1/admin/ai-logs/${logId.toString()}/payload`).set({ Authorization: "Bearer " + admin })

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      logId: logId.toString(),
      actionType: "DRAFT_TO_OPS",
      response: '{"ops":[],"notes":"xong"}',
      promptChars: 52_000,
      responseChars: 24
    })
    expect(res.body.data.prompt).toContain("Bạn là BA")
  })

  it("không còn bản ghi ⇒ 404 AI_PAYLOAD_NOT_FOUND", async () => {
    const adminUser = await User.create({ email: "admin2@flintflow.test", password: "test-password-123", role: "admin", emailVerified: true })
    const admin = await authAs({ _id: adminUser._id, email: adminUser.email, role: "admin" })

    const res = await request(app)
      .get(`/api/v1/admin/ai-logs/${new mongoose.Types.ObjectId().toString()}/payload`)
      .set({ Authorization: "Bearer " + admin })

    expect(res.status).toBe(404)
    expect(res.body.error?.code ?? res.body.code).toBe("AI_PAYLOAD_NOT_FOUND")
  })

  it("user thường không đọc được prompt của người khác ⇒ 403", async () => {
    const plainUser = await User.create({ email: "user@flintflow.test", password: "test-password-123", role: "user", emailVerified: true })
    const token = await authAs({ _id: plainUser._id, email: plainUser.email, role: "user" })
    const logId = new mongoose.Types.ObjectId()
    await seedPayload(logId, plainUser._id)

    const res = await request(app).get(`/api/v1/admin/ai-logs/${logId.toString()}/payload`).set({ Authorization: "Bearer " + token })

    expect(res.status).toBe(403)
  })
})
