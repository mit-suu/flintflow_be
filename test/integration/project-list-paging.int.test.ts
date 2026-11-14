/**
 * FLF-404: `GET /projects?page=…` — dashboard tải dự án theo trang, lọc / tìm không dấu / sắp xếp ở BE; không có `page` thì
 * vẫn trả mảng như cũ. Qua HTTP trên Mongo thật.
 */
import { describe, it, expect } from "vitest"
import mongoose from "mongoose"
import request from "supertest"
import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Folder } from "../../src/modules/folder/folder.model.js"

const as = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })
const DAY = 86_400_000

/** Chèn thẳng (gói Free chặn tạo quá 3 dự án qua API) — mốc thời gian cố định để thứ tự kiểm được. */
const insert = async (seeded: SeededFixture, name: string, at: number, extra: Record<string, unknown> = {}) => {
  const owner = await Project.findById(seeded.projectId).lean()
  const doc = await Project.create({ userId: owner!.userId, organizationId: seeded.orgId, name, ...extra })
  // timestamps tự đặt lúc tạo ⇒ ghi đè bằng updateOne thô (bỏ qua timestamps) để giữ mốc cố định
  await Project.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(at), updatedAt: new Date(at) } })
  return String(doc._id)
}

describe("GET /projects phân trang (FLF-404)", () => {
  it("không có page ⇒ mảng như cũ; có page ⇒ một trang + meta, mới tạo trước", async () => {
    const seeded = await seedFixture("minimal")
    const base = Date.parse("2026-01-01T00:00:00Z")
    for (let i = 0; i < 4; i++) await insert(seeded, `Dự án ${i}`, base + i * DAY)

    const legacy = await request(app).get("/api/v1/projects").set(as(seeded))
    expect(legacy.status).toBe(200)
    expect(Array.isArray(legacy.body.data)).toBe(true)
    expect(legacy.body.data).toHaveLength(5)
    expect(legacy.body.meta).toBeFalsy()

    const page1 = await request(app).get("/api/v1/projects?page=1&limit=2").set(as(seeded))
    expect(page1.status).toBe(200)
    expect(page1.body.meta).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 })
    // Fixture tạo lúc chạy test ⇒ mới nhất; rồi dự án chèn có mốc muộn nhất
    expect(page1.body.data.map((p: { name: string }) => p.name)).toEqual(["FlintFlow (Fixture Minimal)", "Dự án 3"])
    const page3 = await request(app).get("/api/v1/projects?page=3&limit=2").set(as(seeded))
    expect(page3.body.data.map((p: { name: string }) => p.name)).toEqual(["Dự án 0"])
    // Cùng hình JSON với danh sách cũ (cùng document, không lean)
    expect(Object.keys(page1.body.data[0]).sort()).toEqual(Object.keys(legacy.body.data[0]).sort())
  })

  it("lọc trạng thái + cách làm, tìm tên không dấu", async () => {
    const seeded = await seedFixture("minimal")
    const base = Date.parse("2026-02-01T00:00:00Z")
    await insert(seeded, "Ngân hàng số", base, { mode: "import" })
    await insert(seeded, "Ngân hàng cũ", base + DAY, { status: "archived" })
    await insert(seeded, "Cửa hàng online", base + 2 * DAY)

    const search = await request(app).get("/api/v1/projects?page=1&q=ngan%20hang&status=active").set(as(seeded))
    expect(search.body.data.map((p: { name: string }) => p.name)).toEqual(["Ngân hàng số"])
    expect(search.body.meta.total).toBe(1)

    const archived = await request(app).get("/api/v1/projects?page=1&status=archived").set(as(seeded))
    expect(archived.body.data.map((p: { name: string }) => p.name)).toEqual(["Ngân hàng cũ"])

    const imported = await request(app).get("/api/v1/projects?page=1&mode=import").set(as(seeded))
    expect(imported.body.data.map((p: { name: string }) => p.name)).toEqual(["Ngân hàng số"])
  })

  it("folder=<id> chỉ dự án trong thư mục; folder=none chỉ dự án ngoài thư mục", async () => {
    const seeded = await seedFixture("minimal")
    const owner = await Project.findById(seeded.projectId).lean()
    const folder = await Folder.create({ name: "Khách A", organizationId: seeded.orgId, userId: owner!.userId })
    const base = Date.parse("2026-03-01T00:00:00Z")
    await insert(seeded, "Trong thư mục", base, { folderId: folder._id })
    await insert(seeded, "Ngoài thư mục", base + DAY)

    const inside = await request(app).get(`/api/v1/projects?page=1&folder=${folder._id}`).set(as(seeded))
    expect(inside.body.data.map((p: { name: string }) => p.name)).toEqual(["Trong thư mục"])
    const loose = await request(app).get("/api/v1/projects?page=1&folder=none").set(as(seeded))
    expect(loose.body.data.map((p: { name: string }) => p.name).sort()).toEqual(["FlintFlow (Fixture Minimal)", "Ngoài thư mục"])
  })

  it("sort=opened: mở gần nhất trước, chưa mở xếp cuối; sort=updated theo lần sửa", async () => {
    const seeded = await seedFixture("minimal")
    const base = Date.parse("2026-04-01T00:00:00Z")
    const a = await insert(seeded, "A", base)
    const b = await insert(seeded, "B", base + DAY)
    await Project.collection.updateOne({ _id: new mongoose.Types.ObjectId(a) }, { $set: { lastOpenedAt: new Date(base + 9 * DAY) } })
    await Project.collection.updateOne({ _id: new mongoose.Types.ObjectId(b) }, { $set: { lastOpenedAt: new Date(base + 3 * DAY) } })
    await Project.collection.updateOne({ _id: new mongoose.Types.ObjectId(seeded.projectId) }, { $set: { lastOpenedAt: null } })

    const opened = await request(app).get("/api/v1/projects?page=1&sort=opened").set(as(seeded))
    expect(opened.body.data.map((p: { name: string }) => p.name)).toEqual(["A", "B", "FlintFlow (Fixture Minimal)"])

    await Project.collection.updateOne({ _id: new mongoose.Types.ObjectId(a) }, { $set: { updatedAt: new Date("2030-01-01T00:00:00Z") } })
    const updated = await request(app).get("/api/v1/projects?page=1&sort=updated&limit=1").set(as(seeded))
    expect(updated.body.data.map((p: { name: string }) => p.name)).toEqual(["A"])
  })

  it("tham số sai ⇒ 400; không thấy dự án của org khác", async () => {
    const seeded = await seedFixture("minimal")
    const other = await seedFixture("minimal")
    for (const qs of ["page=0", "page=1&limit=101", "page=1&sort=name", "page=1&status=deleted", "page=1&folder=abc", "page=1&mode=x"]) {
      expect((await request(app).get(`/api/v1/projects?${qs}`).set(as(seeded))).status, qs).toBe(400)
    }
    const mine = await request(app).get("/api/v1/projects?page=1").set(as(seeded))
    expect(mine.body.data.map((p: { _id: string }) => p._id)).toEqual([seeded.projectId])
    expect(mine.body.data.map((p: { _id: string }) => p._id)).not.toContain(other.projectId)
  })
})
