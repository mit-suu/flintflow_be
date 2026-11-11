/**
 * FLF-401 — "Xoá vĩnh viễn" dự án ở FE chỉ xoá mềm ở BE: dự án biến khỏi mọi chỗ của app (mở, danh sách, thư mục, quota),
 * dữ liệu còn nguyên trong DB; Lưu trữ giữ nguyên; xoá tổ chức dọn hẳn cả dự án đã xoá mềm.
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { Project, WITH_DELETED } from "../../src/modules/project/project.model.js"
import { Spine } from "../../src/modules/spine/spine.model.js"
import { Folder } from "../../src/modules/folder/folder.model.js"
import { deleteOrganization } from "../../src/modules/organization/organization.service.js"
import { Organization } from "../../src/modules/organization/organization.model.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })
const projectUrl = (id: string, suffix = "") => `/api/v1/projects/${id}${suffix}`

let seeded: SeededFixture
beforeEach(async () => {
  seeded = await seedFixture("minimal")
})

const hardDelete = (id = seeded.projectId) => request(app).delete(projectUrl(id, "?hard=true")).set(bearer(seeded.token))

describe("FLF-401 — Xoá vĩnh viễn = xoá mềm", () => {
  it("dự án biến khỏi app: mở ⇒ 404, không còn trong danh sách / bộ lọc lưu trữ; sửa tên ⇒ 404", async () => {
    expect((await hardDelete()).status).toBe(200)

    const open = await request(app).get(projectUrl(seeded.projectId)).set(bearer(seeded.token))
    expect(open.status).toBe(404)
    expect(open.body.error.code).toBe("PROJECT_NOT_FOUND")
    for (const status of ["active", "archived"]) {
      const list = await request(app).get(`/api/v1/projects?status=${status}`).set(bearer(seeded.token))
      expect(list.body.data.map((p: { _id: string }) => p._id)).not.toContain(seeded.projectId)
    }
    const spine = await request(app).get(projectUrl(seeded.projectId, "/spine")).set(bearer(seeded.token))
    expect(spine.status).toBe(404)
    const rename = await request(app).patch(projectUrl(seeded.projectId, "/name")).set(bearer(seeded.token)).send({ name: "Hồi sinh" })
    expect(rename.status).toBe(404)
  })

  it("dữ liệu còn nguyên: bản ghi có deletedAt, Spine còn; xoá lại ⇒ 404 (đã xoá)", async () => {
    expect((await hardDelete()).status).toBe(200)
    const kept = await Project.findById(seeded.projectId).setOptions(WITH_DELETED).lean()
    expect(kept).not.toBeNull()
    expect(kept!.deletedAt).toBeInstanceOf(Date)
    expect(await Spine.countDocuments({ projectId: seeded.projectId })).toBe(1)
    // Option ở tham số thứ ba (lịch sử thanh toán đọc tên dự án) cũng thấy dự án đã xoá
    expect((await Project.find({ _id: seeded.projectId }, { name: 1 }, WITH_DELETED).lean()).length).toBe(1)
    expect((await Project.find({ _id: seeded.projectId }, { name: 1 }).lean()).length).toBe(0)
    expect((await hardDelete()).status).toBe(404)
  })

  it("thư mục không đếm dự án đã xoá; Lưu trữ vẫn chỉ đổi status, không xoá", async () => {
    const folder = await Folder.create({ organizationId: seeded.orgId, userId: seeded.userId, name: "FLF-401" })
    await Project.updateOne({ _id: seeded.projectId }, { $set: { folderId: folder._id } })
    const before = await request(app).get("/api/v1/folders").set(bearer(seeded.token))
    const countOf = (body: { data: { _id: string; projectCount?: number }[] }) => body.data.find((f) => String(f._id) === String(folder._id))?.projectCount
    expect(countOf(before.body)).toBe(1)

    expect((await hardDelete()).status).toBe(200)
    const after = await request(app).get("/api/v1/folders").set(bearer(seeded.token))
    expect(countOf(after.body)).toBe(0)

    const other = await seedFixture("minimal")
    const archived = await request(app).delete(projectUrl(other.projectId)).set(bearer(other.token))
    expect(archived.body.data.status).toBe("archived")
    expect((await Project.findById(other.projectId).lean())?.deletedAt ?? null).toBeNull()
  })

  it("xoá tổ chức dọn hẳn cả dự án đã xoá mềm", async () => {
    expect((await hardDelete()).status).toBe(200)
    const org = await Organization.findById(seeded.orgId).lean()
    await deleteOrganization(seeded.orgId, seeded.userId, org!.name)
    expect(await Project.countDocuments({ _id: seeded.projectId }).setOptions(WITH_DELETED)).toBe(0)
    expect(await Spine.countDocuments({ projectId: seeded.projectId })).toBe(0)
  })
})
