/**
 * task-26 Pha 1 — chuỗi kiểm quyền theo BPMN Flow 10, chạy trên Mongo thật.
 *
 * Dựng một app express tối giản đúng thứ tự BPMN:
 *   authMiddleware (10.1) → requireActiveAccount (10.4) → orgContext (10.6) → requireRole (10.7)
 * Các middleware này CHƯA được mount vào route thật (việc đó ở Pha 4), nên test tự dựng app.
 */
import { describe, it, expect, beforeEach } from "vitest"
import express from "express"
import request from "supertest"
import mongoose from "mongoose"
import { User } from "../../src/modules/user/user.model.js"
import { Organization } from "../../src/modules/organization/organization.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { authMiddleware } from "../../src/shared/auth/auth.middleware.js"
import { requireActiveAccount } from "../../src/shared/auth/account-guard.middleware.js"
import { orgContext } from "../../src/shared/auth/org-context.middleware.js"
import { requireRole } from "../../src/shared/auth/require-role.middleware.js"
import { errorHandler } from "../../src/shared/middlewares/error-handler.js"
import { signAccessToken } from "../../src/shared/auth/jwt.util.js"

const app = express()
app.get("/protected", authMiddleware, requireActiveAccount, orgContext, (req, res) => {
  res.status(200).json({ data: req.orgContext })
})
app.get("/lead-only", authMiddleware, requireActiveAccount, orgContext, requireRole("lead"), (_req, res) => {
  res.status(200).json({ data: "ok" })
})
app.get("/authors", authMiddleware, requireActiveAccount, orgContext, requireRole("lead", "analyst"), (_req, res) => {
  res.status(200).json({ data: "ok" })
})
app.use(errorHandler)

let userId: string
let orgId: string
let token: string

const tokenFor = (uid: string, oid?: string) =>
  signAccessToken({ userId: uid, email: "member@flintflow.test", ...(oid ? { orgId: oid } : {}) })

beforeEach(async () => {
  const user = await User.create({
    email: "member@flintflow.test",
    password: "member-password-123",
    name: "Thành viên",
    emailVerified: true
  })
  const org = await Organization.create({ name: "Org A", ownerUserId: user._id })
  await Membership.create({ organizationId: org._id, userId: user._id, role: "lead" })
  userId = String(user._id)
  orgId = String(org._id)
  token = tokenFor(userId, orgId)
})

const get = (path: string, bearer = token) =>
  request(app).get(path).set("Authorization", "Bearer " + bearer)

describe("chuỗi kiểm quyền org (BPMN Flow 10)", () => {
  it("thành viên hợp lệ đi qua và nhận đúng vai trò trong org", async () => {
    const res = await get("/protected")
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ orgId, role: "lead" })
  })

  it("10.1 — không có token trả 401", async () => {
    const res = await request(app).get("/protected")
    expect(res.status).toBe(401)
  })

  it("10.4 — tài khoản bị khoá mất quyền NGAY request kế tiếp (UC-66)", async () => {
    expect((await get("/protected")).status).toBe(200)

    await User.updateOne({ _id: userId }, { isActive: false })

    const res = await get("/protected")
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED")
  })

  it("10.6 — bị xoá khỏi org thì request kế tiếp trả 403 (UC-74, Flow 9.9)", async () => {
    expect((await get("/protected")).status).toBe(200)

    await Membership.deleteOne({ organizationId: orgId, userId })

    const res = await get("/protected")
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_FORBIDDEN")
  })

  it("10.6 — token không mang orgId trả 409 để FE đẩy về onboarding (Flow 8)", async () => {
    const res = await get("/protected", tokenFor(userId))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("NO_ACTIVE_ORG")
  })

  it("10.6 — org mình không thuộc về trả 403, không phải 409", async () => {
    const other = await Organization.create({
      name: "Org B",
      ownerUserId: new mongoose.Types.ObjectId()
    })
    const res = await get("/protected", tokenFor(userId, String(other._id)))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_FORBIDDEN")
  })

  it("10.7 — hạ vai trò Lead xuống Viewer thì mất quyền Lead ngay request kế tiếp (UC-73)", async () => {
    expect((await get("/lead-only")).status).toBe(200)

    await Membership.updateOne({ organizationId: orgId, userId }, { role: "viewer" })

    const res = await get("/lead-only")
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("10.7 — Viewer không chạy được việc của Author, Analyst thì được", async () => {
    await Membership.updateOne({ organizationId: orgId, userId }, { role: "viewer" })
    expect((await get("/authors")).status).toBe(403)

    await Membership.updateOne({ organizationId: orgId, userId }, { role: "analyst" })
    expect((await get("/authors")).status).toBe(200)
  })
})
