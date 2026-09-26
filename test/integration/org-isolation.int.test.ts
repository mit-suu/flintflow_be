/**
 * task-26 Pha 4a — dự án thuộc về TỔ CHỨC, không thuộc về người.
 * Chứng minh ba điều: thành viên cùng org thấy chung dự án; org khác không thấy gì; vai trò quyết định
 * làm được gì (BPMN Flow 10.6–10.7). Cộng lỗ hổng Flow 10.4 (tài khoản bị khoá) nay đã đóng.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { authAs, seedFixture } from "../setup.js"

/** Thêm một người vào org của fixture với vai trò cho trước, trả token đã mang orgId. */
const joinOrg = async (orgId: string, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId })
}

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

describe("dự án thuộc về tổ chức", () => {
  it("thành viên khác trong cùng org thấy và mở được dự án của org", async () => {
    const owner = await seedFixture("minimal")
    const mate = await joinOrg(owner.orgId, "mate@flintflow.test", "analyst")

    const list = await request(app).get("/api/v1/projects").set(bearer(mate))
    expect(list.status).toBe(200)
    expect(list.body.data.map((p: { _id: string }) => p._id)).toContain(owner.projectId)

    const open = await request(app).get("/api/v1/projects/" + owner.projectId).set(bearer(mate))
    expect(open.status).toBe(200)
  })

  it("org khác không thấy và không mở được", async () => {
    const owner = await seedFixture("minimal")
    const stranger = await seedFixture("minimal")

    const list = await request(app).get("/api/v1/projects").set(bearer(stranger.token))
    expect(list.body.data.map((p: { _id: string }) => p._id)).not.toContain(owner.projectId)

    const open = await request(app).get("/api/v1/projects/" + owner.projectId).set(bearer(stranger.token))
    expect(open.status).toBe(404)
    expect(open.body.error.code).toBe("PROJECT_NOT_FOUND")

    const spine = await request(app).get("/api/v1/projects/" + owner.projectId + "/spine").set(bearer(stranger.token))
    expect(spine.status).toBe(404)
  })

  it("token không mang orgId ⇒ 409 để FE đẩy về onboarding", async () => {
    const owner = await seedFixture("minimal")
    const tokenWithoutOrg = await authAs(owner.user)

    const res = await request(app).get("/api/v1/projects").set(bearer(tokenWithoutOrg))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("NO_ACTIVE_ORG")
  })
})

describe("vai trò quyết định làm được gì (Flow 10.7)", () => {
  it("Viewer đọc được tiến độ nhưng không chạy được step AI", async () => {
    const owner = await seedFixture("minimal")
    const viewer = await joinOrg(owner.orgId, "viewer@flintflow.test", "viewer")

    const read = await request(app).get("/api/v1/projects/" + owner.projectId + "/steps").set(bearer(viewer))
    expect(read.status).toBe(200)

    const run = await request(app)
      .post("/api/v1/projects/" + owner.projectId + "/steps/B-0.1/run")
      .set(bearer(viewer))
      .send({ session_id: owner.sessionId, base_version: owner.spineVersion })
    expect(run.status).toBe(403)
    expect(run.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("chỉ Lead xoá được dự án (UC-16)", async () => {
    const owner = await seedFixture("minimal")
    const analyst = await joinOrg(owner.orgId, "analyst@flintflow.test", "analyst")

    const denied = await request(app).delete("/api/v1/projects/" + owner.projectId).set(bearer(analyst))
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe("ORG_ROLE_FORBIDDEN")

    // seedFixture tạo user là Lead của org
    const allowed = await request(app).delete("/api/v1/projects/" + owner.projectId).set(bearer(owner.token))
    expect(allowed.status).toBe(200)
  })
})

describe("lỗ hổng Flow 10.4 đã đóng", () => {
  it("tài khoản bị khoá mất quyền ngay ở request kế tiếp, không đợi token hết hạn", async () => {
    const owner = await seedFixture("minimal")
    expect((await request(app).get("/api/v1/projects").set(bearer(owner.token))).status).toBe(200)

    await User.updateOne({ _id: owner.userId }, { isActive: false })

    const res = await request(app).get("/api/v1/projects").set(bearer(owner.token))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED")
  })

  it("bị xoá khỏi org thì mất quyền vào dự án của org đó ngay (UC-74)", async () => {
    const owner = await seedFixture("minimal")
    const mate = await joinOrg(owner.orgId, "mate2@flintflow.test", "analyst")
    expect((await request(app).get("/api/v1/projects").set(bearer(mate))).status).toBe(200)

    await Membership.deleteOne({ organizationId: owner.orgId, userId: { $ne: owner.userId } })

    const res = await request(app).get("/api/v1/projects").set(bearer(mate))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_FORBIDDEN")
  })
})
