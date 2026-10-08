/**
 * spine-api (T22) — endpoint 1 `GET /projects/:id/spine` qua HTTP trên Mongo thật.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import mongoose from "mongoose"
import app from "../../src/app.js"
import { authAs, seedFixture, type Envelope } from "../setup.js"
import { spineRecordSchema } from "../../src/modules/spine/spine.schema.js"

describe("GET /api/v1/projects/:id/spine", () => {
  it("401 khi thiếu token", async () => {
    const res = await request(app).get(`/api/v1/projects/${new mongoose.Types.ObjectId()}/spine`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe("MISSING_ACCESS_TOKEN")
  })

  it("trả Spine fixture 19 màn đúng schema, đúng spine_version đã seed", async () => {
    const seeded = await seedFixture("full")
    const res = await request(app).get(`/api/v1/projects/${seeded.projectId}/spine`).set("Authorization", `Bearer ${seeded.token}`)

    expect(res.status).toBe(200)
    const body = res.body as Envelope<Record<string, unknown>>
    expect(body.error).toBeNull()
    const spine = spineRecordSchema.parse(body.data)
    expect(spine.spine_version).toBe(seeded.spineVersion)
    expect(spine.screens.length).toBe(19)
  })

  it("project cũ chưa có Spine ⇒ tạo Spine rỗng lần đầu đọc, lần đọc sau trả cùng bản", async () => {
    const seeded = await seedFixture("minimal", { withoutSpine: true })
    const first = await request(app).get(`/api/v1/projects/${seeded.projectId}/spine`).set("Authorization", `Bearer ${seeded.token}`)
    expect(first.status).toBe(200)
    expect(first.body.data.project.name).toBe("FlintFlow (Fixture Minimal)")

    const second = await request(app).get(`/api/v1/projects/${seeded.projectId}/spine`).set("Authorization", `Bearer ${seeded.token}`)
    expect(second.body.data.spine_version).toBe(first.body.data.spine_version)
  })

  it("404 PROJECT_NOT_FOUND với project của user khác và id sai định dạng", async () => {
    const owner = await seedFixture("minimal")
    const other = await seedFixture("minimal")

    const foreign = await request(app).get(`/api/v1/projects/${owner.projectId}/spine`).set("Authorization", `Bearer ${other.token}`)
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe("PROJECT_NOT_FOUND")

    const token = await authAs({ ...owner.user, orgId: owner.orgId })
    const malformed = await request(app).get("/api/v1/projects/not-an-id/spine").set("Authorization", `Bearer ${token}`)
    expect(malformed.status).toBe(404)
  })
})
