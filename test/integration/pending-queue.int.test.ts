/**
 * pending-queue (FLF-443, endpoint 51) - GET /projects/:id/pending-queue qua HTTP trên Mongo thật.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { authAs, seedFixture } from "../setup.js"
import { pendingQueueResponseSchema } from "../../src/modules/pipeline/pipeline.dto.js"

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
const url = (projectId: string) => `/api/v1/projects/${projectId}/pending-queue`

const join = async (orgId: string, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId })
}

/** Dựng Spine đang ở Brief với 1 giả định, 1 ghi chú, 1 cờ đỏ và 2 cờ vàng cùng phần tử. */
const briefMutation = (raw: Record<string, unknown>): void => {
  const flagBase = {
    section_id: "fixed:5.2",
    message: "m",
    opened_at_version: 1,
    resolved_at: null,
    waived_by_user: false,
    waive_reason: null,
    waived_at_version: null,
    kept_reason: null,
    kept_by: null,
    kept_at: null
  }
  ;(raw.progress as Record<string, unknown>).current_phase = "S-1"
  raw.assumptions = [
    { id: "AS1", path: "project.vision", statement: "s", rationale: "r", origin_step_id: "B-1.2", status: "unconfirmed", confirmed_at: null },
    { id: "AS2", path: "project.vision", statement: "s", rationale: "r", origin_step_id: "B-1.2", status: "confirmed", confirmed_at: "2026-11-18T00:00:00.000Z" }
  ]
  raw.addendum = [{ id: "AD1", topic: "t", content: "c", content_en: "c", target_section: "fixed:5.4", captured_at: "2026-11-18T00:00:00.000Z" }]
  raw.flags = [
    { ...flagBase, id: "FL1", level: "red", rule_id: "dead_reference", target_id: null, remediation_step: "S-6.1" },
    { ...flagBase, id: "FL2", level: "yellow", rule_id: "r1", target_id: null, remediation_step: "S-7.2" },
    { ...flagBase, id: "FL3", level: "yellow", rule_id: "r1", target_id: null, remediation_step: "S-7.2" }
  ]
}

describe("GET /pending-queue", () => {
  it("Lead 200: đúng phạm vi Brief và thứ tự loại, khớp DTO", async () => {
    const seeded = await seedFixture("minimal", { mutate: briefMutation })
    const res = await request(app).get(url(seeded.projectId)).set(bearer(seeded.token))
    expect(res.status).toBe(200)
    const queue = pendingQueueResponseSchema.parse(res.body.data)
    expect(queue.total).toBe(4)
    expect(queue.items.map((i) => i.key)).toEqual(["assumption:AS1", "brief_note:AD1", "flag_red:FL1", "flag_yellow_group:r1@fixed:5.2"])
    expect(queue.items[3]).toMatchObject({ blocking: false, refs: { flag_ids: ["FL2", "FL3"] } })
    // Số việc không phải cờ ở Brief = giả định chưa xác nhận + ghi chú (công thức tab Chờ quyết)
    expect(queue.items.filter((i) => !i.kind.startsWith("flag_"))).toHaveLength(2)
  })

  it("Analyst 200", async () => {
    const seeded = await seedFixture("minimal", { mutate: briefMutation })
    const analyst = await join(seeded.orgId, "analyst-pq@flintflow.test", "analyst")
    const res = await request(app).get(url(seeded.projectId)).set(bearer(analyst))
    expect(res.status).toBe(200)
  })

  it("dự án chưa có Spine ⇒ { total: 0, items: [] }", async () => {
    const seeded = await seedFixture("minimal", { withoutSpine: true })
    const res = await request(app).get(url(seeded.projectId)).set(bearer(seeded.token))
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ total: 0, items: [] })
  })

  it("Viewer 403 ORG_ROLE_FORBIDDEN", async () => {
    const seeded = await seedFixture("minimal", { mutate: briefMutation })
    const viewer = await join(seeded.orgId, "viewer-pq@flintflow.test", "viewer")
    const res = await request(app).get(url(seeded.projectId)).set(bearer(viewer))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("dự án của org khác ⇒ 404 PROJECT_NOT_FOUND", async () => {
    const mine = await seedFixture("minimal", { mutate: briefMutation })
    const other = await seedFixture("minimal")
    const res = await request(app).get(url(mine.projectId)).set(bearer(other.token))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
  })

  it("chưa đăng nhập ⇒ 401", async () => {
    const seeded = await seedFixture("minimal")
    const res = await request(app).get(url(seeded.projectId))
    expect(res.status).toBe(401)
  })
})
