/**
 * Viewer chỉ đọc — chốt `viewerReadOnly` ở tầng app. Trước đây ~50 endpoint ghi dưới /projects và /folders không
 * chặn vai trò: Viewer gọi API thẳng vẫn sửa được tài liệu, change request, release, thư mục…
 * Kiểm theo hành vi, không theo validation: chốt chạy TRƯỚC validation nên body rỗng là đủ.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../src/modules/organization/membership.model.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"

const join = async (orgId: string, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId })
}

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

let seeded: SeededFixture
let viewer: string
let analyst: string

beforeEach(async () => {
  seeded = await seedFixture("minimal")
  viewer = await join(seeded.orgId, "viewer@flintflow.test", "viewer")
  analyst = await join(seeded.orgId, "analyst@flintflow.test", "analyst")
})

describe("Viewer bị chặn ở mọi thao tác ghi", () => {
  const writes = (projectId: string): Array<[string, string]> => [
    ["post", "/api/v1/projects/" + projectId + "/changes"],
    ["post", "/api/v1/projects/" + projectId + "/undo"],
    ["post", "/api/v1/projects/" + projectId + "/release"],
    ["post", "/api/v1/projects/" + projectId + "/baseline"],
    ["post", "/api/v1/projects/" + projectId + "/flags/F-1/waive"],
    ["post", "/api/v1/projects/" + projectId + "/change-requests"],
    ["patch", "/api/v1/projects/" + projectId + "/name"],
    ["post", "/api/v1/projects"],
    ["post", "/api/v1/folders"]
  ]

  it("mọi endpoint ghi tiêu biểu trả 403 ORG_ROLE_FORBIDDEN", async () => {
    for (const [method, path] of writes(seeded.projectId)) {
      const res = await request(app)[method as "post" | "patch"](path).set(bearer(viewer)).send({})
      expect(res.status, method.toUpperCase() + " " + path).toBe(403)
      expect(res.body.error.code, path).toBe("ORG_ROLE_FORBIDDEN")
    }
  })

  it("Analyst gọi đúng các endpoint đó thì không bị chốt này chặn", async () => {
    for (const [method, path] of writes(seeded.projectId)) {
      const res = await request(app)[method as "post" | "patch"](path).set(bearer(analyst)).send({})
      expect(res.body.error?.code, method.toUpperCase() + " " + path).not.toBe("ORG_ROLE_FORBIDDEN")
    }
  })
})

describe("Viewer vẫn đọc được", () => {
  it("xem danh sách dự án, Spine, tiến độ", async () => {
    for (const path of ["/api/v1/projects", "/api/v1/projects/" + seeded.projectId + "/spine", "/api/v1/projects/" + seeded.projectId + "/steps"]) {
      const res = await request(app).get(path).set(bearer(viewer))
      expect(res.status, path).toBe(200)
    }
  })

  it("ghép tài liệu (chỉ dựng bản đọc) không bị chốt chặn", async () => {
    const res = await request(app)
      .post("/api/v1/projects/" + seeded.projectId + "/assemble")
      .set(bearer(viewer))
      .send({ base_version: seeded.spineVersion })
    expect(res.body.error?.code).not.toBe("ORG_ROLE_FORBIDDEN")
    expect(res.status).not.toBe(403)
  })
})
