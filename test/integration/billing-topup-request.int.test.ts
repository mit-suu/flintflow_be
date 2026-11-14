/**
 * FLF-332 (BR-08) — Analyst báo Lead nạp credit qua HTTP trên Mongo thật: Lead nhận thông báo (không dội trùng), nạp xong
 * (webhook / admin) ⇒ người yêu cầu được báo, yêu cầu đóng. Không có lượt gọi AI nào.
 */
import { describe, expect, it, vi } from "vitest"
import mongoose from "mongoose"
import request from "supertest"
import app from "../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Notification } from "../../src/modules/notification/notification.model.js"
import { CreditTopupRequest } from "../../src/modules/billing/credit-topup-request.model.js"
import { fulfillTopupRequests } from "../../src/modules/billing/topup-request.service.js"
import { ChangeRequest } from "../../src/modules/change-request/change-request.model.js"
import { ImportedDocument } from "../../src/modules/import/imported-document.model.js"
import { StepRun } from "../../src/modules/pipeline/run-state.model.js"

const joinOrg = async (orgId: string, role: "lead" | "analyst") => {
  const email = `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}@flintflow.test`
  const user = await User.create({ email, password: "test-password-123", emailVerified: true, name: role === "analyst" ? "BA Linh" : "Lead Hai" })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return { id: String(user._id), token: await authAs({ _id: user._id, email, orgId }) }
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

const notificationsOf = async (userId: string, type: string, n: number) => {
  await vi.waitFor(async () => expect(await Notification.countDocuments({ userId, type })).toBe(n), { timeout: 3000 })
  return Notification.find({ userId, type }).sort({ createdAt: 1 }).lean()
}

describe("POST /billing/topup-request", () => {
  it("Analyst báo ⇒ yêu cầu open, mọi Lead (trừ người báo) nhận credit_topup_requested; bấm lại ⇒ cập nhật, không báo trùng", async () => {
    const seeded: SeededFixture = await seedFixture("minimal")
    const lead2 = await joinOrg(seeded.orgId, "lead")
    const analyst = await joinOrg(seeded.orgId, "analyst")

    const res = await request(app).post("/api/v1/billing/topup-request").set(bearer(analyst.token)).send({ projectId: seeded.projectId, step: "S-5.4@S03", needed: 40 })
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    expect(res.body.data).toMatchObject({ status: "open", user_id: analyst.id, project_id: seeded.projectId, step: "S-5.4@S03", needed: 40, notified_leads: 2 })

    const [n] = await notificationsOf(seeded.userId, "credit_topup_requested", 1)
    expect(n.title).toContain("BA Linh cần nạp credit")
    expect(n.body).toContain("S-5.4@S03")
    expect(n.meta).toMatchObject({ requestedBy: analyst.id, needed: 40 })
    await notificationsOf(lead2.id, "credit_topup_requested", 1)
    expect(await Notification.countDocuments({ userId: analyst.id, type: "credit_topup_requested" })).toBe(0)

    const again = await request(app).post("/api/v1/billing/topup-request").set(bearer(analyst.token)).send({ needed: 60 })
    expect(again.status).toBe(201)
    expect(again.body.data).toMatchObject({ status: "open", needed: 60, notified_leads: 0 })
    expect(await CreditTopupRequest.countDocuments({ organizationId: seeded.orgId, userId: analyst.id })).toBe(1)
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "credit_topup_requested" })).toBe(1)
  })

  it("ví được nạp ⇒ yêu cầu fulfilled, người yêu cầu nhận credit_topped_up nói rõ phải bấm tiếp tục; Lead tự báo không tự nhận", async () => {
    const seeded = await seedFixture("minimal")
    const analyst = await joinOrg(seeded.orgId, "analyst")
    await request(app).post("/api/v1/billing/topup-request").set(bearer(analyst.token)).send({ projectId: seeded.projectId })
    await request(app).post("/api/v1/billing/topup-request").set(bearer(seeded.token)).send({})

    expect(await fulfillTopupRequests(seeded.orgId, 100, { kind: "payment", userId: seeded.userId })).toBe(2)
    expect(await CreditTopupRequest.countDocuments({ organizationId: seeded.orgId, status: "open" })).toBe(0)
    const [n] = await notificationsOf(analyst.id, "credit_topped_up", 1)
    expect(n.title).toContain("100 credit")
    expect(n.body).toContain("bấm tiếp tục")
    expect(n.link).toBe(`/projects/${seeded.projectId}`)
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "credit_topped_up" })).toBe(0)
    // Không còn yêu cầu mở ⇒ nạp lần nữa không báo ai
    expect(await fulfillTopupRequests(seeded.orgId, 50, { kind: "admin", userId: null })).toBe(0)
  })

  it("không bấm Báo Lead nạp: phát hiện CR paused credits + StepRun INSUFFICIENT_CREDIT, gộp 1 thông báo mỗi thành viên, payment không báo Lead nạp, admin báo cả Lead", async () => {
    const seeded = await seedFixture("minimal")
    const analyst = await joinOrg(seeded.orgId, "analyst")
    const analystObjectId = new mongoose.Types.ObjectId(analyst.id)

    await ChangeRequest.create({
      projectId: seeded.projectId,
      cr_id: "CR-001",
      title: "Sửa rule mật khẩu",
      description: "Tăng độ dài tối thiểu lên 10 ký tự",
      source: { kind: "stakeholder_email", ref: null, note: null },
      requester: "PM Lan",
      status: "proposing",
      paused: { reason: "credits", at: new Date() },
      base_doc_version: "0.0",
      created_by: analystObjectId
    })

    const now = new Date()
    await StepRun.create([
      {
        projectId: seeded.projectId,
        step_id: "S-3.1",
        run_id: "run-analyst-1",
        by: analyst.id,
        status: "interrupted",
        stage: "draft",
        started_at: now,
        last_event_at: now,
        locked_until: now,
        error: { code: "INSUFFICIENT_CREDIT", message: "Hết credit" }
      },
      {
        projectId: seeded.projectId,
        step_id: "S-3.2",
        run_id: "run-lead-1",
        by: seeded.userId,
        status: "interrupted",
        stage: "draft",
        started_at: now,
        last_event_at: now,
        locked_until: now,
        error: { code: "INSUFFICIENT_CREDIT", message: "Hết credit" }
      }
    ])

    // Payment từ Lead: gửi đúng 1 credit_topped_up cho Analyst (gộp CR + StepRun), 0 cho Lead đang thanh toán
    expect(await fulfillTopupRequests(seeded.orgId, 100, { kind: "payment", userId: seeded.userId })).toBe(2)
    const [analystNotice] = await notificationsOf(analyst.id, "credit_topped_up", 1)
    expect(String(analystNotice.organizationId)).toBe(seeded.orgId)
    expect(analystNotice.body).toContain("bấm tiếp tục")
    expect(analystNotice.link).toBe(`/projects/${seeded.projectId}`)
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "credit_topped_up" })).toBe(0)

    const crAfter = await ChangeRequest.findOne({ projectId: seeded.projectId, cr_id: "CR-001" }).lean()
    expect(crAfter?.paused?.reason).toBe("credits")
    expect(crAfter?.status).toBe("proposing")

    // Admin cộng credit: không có Lead nào đang trả tiền ⇒ báo cả Analyst lẫn Lead
    expect(await fulfillTopupRequests(seeded.orgId, 50, { kind: "admin", userId: null })).toBe(2)
    await notificationsOf(analyst.id, "credit_topped_up", 2)
    const [leadNotice] = await notificationsOf(seeded.userId, "credit_topped_up", 1)
    expect(String(leadNotice.organizationId)).toBe(seeded.orgId)
    expect(leadNotice.body).toContain("Quản trị viên đã nạp 50 credit")
  })

  it("phát hiện ImportedDocument đang paused credits của dự án chưa xoá mềm; bỏ qua dự án đã xoá mềm", async () => {
    const seeded = await seedFixture("minimal")
    const activeAnalyst = await joinOrg(seeded.orgId, "analyst")
    const deletedAnalyst = await joinOrg(seeded.orgId, "analyst")

    const deletedProject = await Project.create({
      userId: deletedAnalyst.id,
      organizationId: seeded.orgId,
      name: "Deleted Project",
      mode: "import",
      deletedAt: new Date()
    })

    await ImportedDocument.create([
      {
        projectId: seeded.projectId,
        sha256: "hash-active",
        original_name: "active.docx",
        size: 100,
        preflight: { status: "accepted", issues: [] },
        status: "extracting",
        paused: { reason: "credits", at: new Date() },
        extract_cursor: "fixed:1",
        created_by: new mongoose.Types.ObjectId(activeAnalyst.id)
      },
      {
        projectId: deletedProject._id,
        sha256: "hash-deleted",
        original_name: "deleted.docx",
        size: 100,
        preflight: { status: "accepted", issues: [] },
        status: "checking",
        paused: { reason: "credits", at: new Date() },
        extract_cursor: null,
        created_by: new mongoose.Types.ObjectId(deletedAnalyst.id)
      }
    ])

    expect(await fulfillTopupRequests(seeded.orgId, 80, { kind: "payment", userId: seeded.userId })).toBe(1)
    await notificationsOf(activeAnalyst.id, "credit_topped_up", 1)
    expect(await Notification.countDocuments({ userId: deletedAnalyst.id, type: "credit_topped_up" })).toBe(0)
  })

  it("Viewer không báo được (403); không có org ⇒ 400/403", async () => {
    const seeded = await seedFixture("minimal")
    const viewer = await joinOrg(seeded.orgId, "lead")
    await Membership.updateOne({ userId: viewer.id, organizationId: seeded.orgId }, { $set: { role: "viewer" } })
    const res = await request(app).post("/api/v1/billing/topup-request").set(bearer(viewer.token)).send({})
    expect(res.status).toBe(403)
  })

  it("Analyst mở yêu cầu / có bước paused nhưng bị hạ xuống viewer hoặc xoá Membership trước khi nạp ⇒ đóng yêu cầu mở nhưng KHÔNG gửi credit_topped_up", async () => {
    const seeded = await seedFixture("minimal")
    const demoted = await joinOrg(seeded.orgId, "analyst")
    const removed = await joinOrg(seeded.orgId, "analyst")

    expect((await request(app).post("/api/v1/billing/topup-request").set(bearer(demoted.token)).send({ projectId: seeded.projectId, step: "I-4:fixed:1" })).status).toBe(201)
    expect((await request(app).post("/api/v1/billing/topup-request").set(bearer(removed.token)).send({ projectId: seeded.projectId, step: "I-1.11" })).status).toBe(201)

    await ImportedDocument.create([
      {
        projectId: seeded.projectId,
        sha256: "hash-demoted",
        original_name: "demoted.docx",
        size: 100,
        preflight: { status: "accepted", issues: [] },
        status: "extracting",
        paused: { reason: "credits", at: new Date() },
        extract_cursor: "fixed:1",
        created_by: new mongoose.Types.ObjectId(demoted.id)
      },
      {
        projectId: seeded.projectId,
        sha256: "hash-removed",
        original_name: "removed.docx",
        size: 100,
        preflight: { status: "accepted", issues: [] },
        status: "checking",
        paused: { reason: "credits", at: new Date() },
        extract_cursor: null,
        created_by: new mongoose.Types.ObjectId(removed.id)
      }
    ])

    await Membership.updateOne({ userId: demoted.id, organizationId: seeded.orgId }, { $set: { role: "viewer" } })
    await Membership.deleteOne({ userId: removed.id, organizationId: seeded.orgId })

    expect(await fulfillTopupRequests(seeded.orgId, 120, { kind: "payment", userId: seeded.userId })).toBe(0)
    expect(await CreditTopupRequest.countDocuments({ organizationId: seeded.orgId, status: "open" })).toBe(0)
    expect(await CreditTopupRequest.countDocuments({ organizationId: seeded.orgId, status: "fulfilled" })).toBe(2)
    expect(await Notification.countDocuments({ userId: { $in: [demoted.id, removed.id] }, type: "credit_topped_up" })).toBe(0)

    // Thành viên còn quyền Analyst mở yêu cầu mới sau đó vẫn nhận credit_topped_up bình thường; người đã hạ quyền giữ nguyên 0 thông báo
    const activeAnalyst = await joinOrg(seeded.orgId, "analyst")
    expect((await request(app).post("/api/v1/billing/topup-request").set(bearer(activeAnalyst.token)).send({ projectId: seeded.projectId })).status).toBe(201)
    expect(await fulfillTopupRequests(seeded.orgId, 60, { kind: "payment", userId: seeded.userId })).toBe(1)
    await notificationsOf(activeAnalyst.id, "credit_topped_up", 1)
    expect(await Notification.countDocuments({ userId: { $in: [demoted.id, removed.id] }, type: "credit_topped_up" })).toBe(0)
  })
})
