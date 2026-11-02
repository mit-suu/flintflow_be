/**
 * Ký pháp ERD là thuộc tính dự án: `PATCH /projects/:id/erd-notation` chỉ Lead/Analyst, GET trả `erdNotation` (dự án cũ
 * không có field đọc là `chen`), đổi ký pháp thì ERD đã vẽ được vẽ lại bằng ký pháp mới. Qua HTTP trên Mongo thật.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { renderDiagram } from "../../src/modules/diagram/diagram.service.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"
import { staleDiagrams } from "../../src/modules/diagram/diagram.service.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

const join = async (orgId: string, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId })
}

let seeded: SeededFixture

beforeEach(async () => {
  seeded = await seedFixture("full")
})

const patch = (projectId: string, token: string, body: unknown) =>
  request(app).patch(`/api/v1/projects/${projectId}/erd-notation`).set(bearer(token)).send(body as object)

describe("erdNotation trên Project", () => {
  it("dự án mới có chen; dự án cũ thiếu field cũng đọc ra chen", async () => {
    const created = await request(app).post("/api/v1/projects").set(bearer(seeded.token)).send({ name: "Lumen" })
    expect(created.body.data.erdNotation).toBe("chen")

    await Project.collection.updateOne({ _id: (await Project.findById(seeded.projectId))!._id }, { $unset: { erdNotation: "" } })
    const raw = await Project.collection.findOne({ _id: (await Project.findById(seeded.projectId))!._id })
    expect(raw).not.toHaveProperty("erdNotation")
    const one = await request(app).get(`/api/v1/projects/${seeded.projectId}`).set(bearer(seeded.token))
    expect(one.body.data.erdNotation).toBe("chen")
    const list = await request(app).get("/api/v1/projects").set(bearer(seeded.token))
    expect(list.body.data.find((p: { _id: string }) => p._id === seeded.projectId).erdNotation).toBe("chen")
  })
})

describe("PATCH /projects/:id/erd-notation", () => {
  it("Lead và Analyst đổi được ⇒ 200, GET trả giá trị mới", async () => {
    const lead = await patch(seeded.projectId, seeded.token, { erdNotation: "crowsfoot" })
    expect(lead.status).toBe(200)
    expect(lead.body.data.erdNotation).toBe("crowsfoot")

    const analyst = await join(seeded.orgId, "analyst@flintflow.test", "analyst")
    expect((await patch(seeded.projectId, analyst, { erdNotation: "idef1x" })).status).toBe(200)

    const one = await request(app).get(`/api/v1/projects/${seeded.projectId}`).set(bearer(seeded.token))
    expect(one.body.data.erdNotation).toBe("idef1x")
  })

  it("Viewer ⇒ 403 ORG_ROLE_FORBIDDEN, không ghi", async () => {
    const viewer = await join(seeded.orgId, "viewer@flintflow.test", "viewer")
    const res = await patch(seeded.projectId, viewer, { erdNotation: "idef1x" })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect((await Project.findById(seeded.projectId).lean())?.erdNotation).toBe("chen")
  })

  it("giá trị lạ, thiếu field hoặc key lạ ⇒ 400 VALIDATION_ERROR", async () => {
    for (const body of [{ erdNotation: "uml" }, {}, { erdNotation: "chen", name: "đổi tên lén" }]) {
      const res = await patch(seeded.projectId, seeded.token, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
    }
    expect((await Project.findById(seeded.projectId).lean())?.erdNotation).toBe("chen")
  })

  it("dự án của org khác ⇒ 404 PROJECT_NOT_FOUND; id sai định dạng ⇒ 404", async () => {
    const other = await seedFixture("full")
    const foreign = await patch(other.projectId, seeded.token, { erdNotation: "idef1x" })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe("PROJECT_NOT_FOUND")
    expect((await Project.findById(other.projectId).lean())?.erdNotation).toBe("chen")
    expect((await patch("khong-phai-id", seeded.token, { erdNotation: "idef1x" })).status).toBe(404)
  })

  it("ERD đã vẽ ⇒ đổi ký pháp vẽ lại ngay: hình mới, hash mới, không stale; không đổi gì ⇒ không vẽ lại", async () => {
    await renderDiagram(seeded.projectId, "erd", null, { by: "test" })
    const before = (await spineRepository.get(seeded.projectId))!.diagrams.find((d) => d.kind === "erd")!
    expect(before.render_status).toBe("ok")

    // chọn lại đúng ký pháp hiện tại: không vẽ lại
    expect((await patch(seeded.projectId, seeded.token, { erdNotation: "chen" })).status).toBe(200)
    expect((await spineRepository.get(seeded.projectId))!.diagrams.find((d) => d.kind === "erd")!.rendered_at).toBe(before.rendered_at)

    expect((await patch(seeded.projectId, seeded.token, { erdNotation: "crowsfoot" })).status).toBe(200)
    const record = (await spineRepository.get(seeded.projectId))!
    const after = record.diagrams.find((d) => d.kind === "erd")!
    expect(after.id).toBe(before.id)
    expect(after.render_status).toBe("ok")
    expect(after.source_hash).not.toBe(before.source_hash)
    expect(after.source).not.toBe(before.source)
    expect(after.source).not.toContain("<polygon") // không còn hình thoi Chen
    const { projectId: _projectId, ...spine } = record
    expect(staleDiagrams(spine, { erdNotation: "crowsfoot" }).map((d) => d.kind)).not.toContain("erd")
    // hình đang có không khớp ký pháp khác ⇒ stale
    expect(staleDiagrams(spine, { erdNotation: "idef1x" }).map((d) => d.kind)).toContain("erd")
  })

  it("chưa vẽ ERD ⇒ đổi ký pháp chỉ ghi field: Spine không đổi, không tạo hình", async () => {
    const bare = await seedFixture("minimal")
    const before = (await spineRepository.get(bare.projectId))!
    expect(before.diagrams.some((d) => d.kind === "erd")).toBe(false)
    expect((await patch(bare.projectId, bare.token, { erdNotation: "crowsfoot" })).status).toBe(200)
    const after = (await spineRepository.get(bare.projectId))!
    expect(after.spine_version).toBe(before.spine_version)
    expect(after.diagrams.some((d) => d.kind === "erd")).toBe(false)
    expect((await Project.findById(bare.projectId).lean())?.erdNotation).toBe("crowsfoot")
  })
})
