/**
 * FLF-418: mức Sequence Diagram là thuộc tính dự án, cùng cách làm với ký pháp ERD (`project-erd-notation.int.test.ts`).
 * `PATCH /projects/:id/sequence-level` chỉ Lead/Analyst; dự án chưa chọn không có field (vẽ là `system`, S-5.4 hỏi trong
 * khung chat). Vẽ lại sơ đồ đã có cần PlantUML server và hash có mức (P5) — ở đây chỉ kiểm phần ghi field qua HTTP.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"
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

const patch = (projectId: string, token: string, body: unknown) =>
  request(app).patch(`/api/v1/projects/${projectId}/sequence-level`).set(bearer(token)).send(body as object)

describe("PATCH /projects/:id/sequence-level", () => {
  it("dự án mới chưa chọn (không có field); Lead và Analyst đổi được ⇒ 200, GET trả giá trị mới", async () => {
    const created = await request(app).post("/api/v1/projects").set(bearer(seeded.token)).send({ name: "Lumen" })
    expect(created.body.data.sequenceLevel).toBeUndefined()

    const lead = await patch(seeded.projectId, seeded.token, { sequenceLevel: "component" })
    expect(lead.status).toBe(200)
    expect(lead.body.data.sequenceLevel).toBe("component")

    const analyst = await join(seeded.orgId, "analyst@flintflow.test", "analyst")
    expect((await patch(seeded.projectId, analyst, { sequenceLevel: "system" })).status).toBe(200)
    const one = await request(app).get(`/api/v1/projects/${seeded.projectId}`).set(bearer(seeded.token))
    expect(one.body.data.sequenceLevel).toBe("system")
  })

  it("Viewer ⇒ 403 ORG_ROLE_FORBIDDEN, không ghi", async () => {
    const viewer = await join(seeded.orgId, "viewer@flintflow.test", "viewer")
    const res = await patch(seeded.projectId, viewer, { sequenceLevel: "component" })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect((await Project.findById(seeded.projectId).lean())?.sequenceLevel).toBeUndefined()
  })

  it("giá trị lạ, thiếu field hoặc key lạ ⇒ 400 VALIDATION_ERROR", async () => {
    for (const body of [{ sequenceLevel: "design" }, {}, { sequenceLevel: "system", name: "đổi tên lén" }]) {
      const res = await patch(seeded.projectId, seeded.token, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
    }
    expect((await Project.findById(seeded.projectId).lean())?.sequenceLevel).toBeUndefined()
  })

  it("dự án của org khác ⇒ 404 PROJECT_NOT_FOUND; id sai định dạng ⇒ 404", async () => {
    const other = await seedFixture("minimal")
    const foreign = await patch(other.projectId, seeded.token, { sequenceLevel: "component" })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe("PROJECT_NOT_FOUND")
    expect((await patch("khong-phai-id", seeded.token, { sequenceLevel: "component" })).status).toBe(404)
  })

  it("chưa vẽ sequence ⇒ đổi mức chỉ ghi field: Spine không đổi, không tạo hình", async () => {
    const before = (await spineRepository.get(seeded.projectId))!
    expect(before.diagrams.some((d) => d.kind === "sequence")).toBe(false)
    expect((await patch(seeded.projectId, seeded.token, { sequenceLevel: "component" })).status).toBe(200)
    const after = (await spineRepository.get(seeded.projectId))!
    expect(after.spine_version).toBe(before.spine_version)
    expect(after.diagrams.some((d) => d.kind === "sequence")).toBe(false)
  })
})
