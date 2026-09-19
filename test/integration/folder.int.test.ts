/**
 * Thư mục dự án qua HTTP trên Mongo thật: CRUD, đếm dự án, chuyển dự án vào/ra thư mục, cô lập giữa user,
 * xoá thư mục giữ lại dự án.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"

const as = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })

describe("folders", () => {
  it("tạo, đổi tên, chuyển dự án vào ⇒ projectCount; xoá folder thì dự án ra ngoài", async () => {
    const seeded = await seedFixture("minimal")

    const created = await request(app).post("/api/v1/folders").set(as(seeded)).send({ name: "Khách A", color: "blue" })
    expect(created.status).toBe(201)
    const folderId = created.body.data._id as string
    expect(created.body.data).toMatchObject({ name: "Khách A", color: "blue", projectCount: 0 })

    const renamed = await request(app).patch(`/api/v1/folders/${folderId}`).set(as(seeded)).send({ name: "Khách A+" })
    expect(renamed.body.data.name).toBe("Khách A+")

    const moved = await request(app).patch(`/api/v1/projects/${seeded.projectId}/folder`).set(as(seeded)).send({ folderId })
    expect(moved.status).toBe(200)
    expect(moved.body.data.folderId).toBe(folderId)

    const list = await request(app).get("/api/v1/folders").set(as(seeded))
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].projectCount).toBe(1)

    const removed = await request(app).delete(`/api/v1/folders/${folderId}`).set(as(seeded))
    expect(removed.body.data).toEqual({ _id: folderId, releasedProjects: 1 })
    const project = await request(app).get(`/api/v1/projects/${seeded.projectId}`).set(as(seeded))
    expect(project.status).toBe(200)
    expect(project.body.data.folderId).toBeNull()
  })

  it("folderId null ⇒ ra ngoài thư mục; tên rỗng ⇒ 400", async () => {
    const seeded = await seedFixture("minimal")
    const res = await request(app).patch(`/api/v1/projects/${seeded.projectId}/folder`).set(as(seeded)).send({ folderId: null })
    expect(res.status).toBe(200)
    expect(res.body.data.folderId).toBeNull()

    const bad = await request(app).post("/api/v1/folders").set(as(seeded)).send({ name: "  " })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("không đụng được folder của user khác ⇒ 404", async () => {
    const owner = await seedFixture("minimal")
    const other = await seedFixture("minimal")
    const folder = await request(app).post("/api/v1/folders").set(as(owner)).send({ name: "Riêng" })
    const folderId = folder.body.data._id as string

    expect((await request(app).get("/api/v1/folders").set(as(other))).body.data).toEqual([])
    expect((await request(app).patch(`/api/v1/folders/${folderId}`).set(as(other)).send({ name: "x" })).status).toBe(404)
    expect((await request(app).delete(`/api/v1/folders/${folderId}`).set(as(other))).status).toBe(404)
    const move = await request(app).patch(`/api/v1/projects/${other.projectId}/folder`).set(as(other)).send({ folderId })
    expect(move.status).toBe(404)
    expect(move.body.error.code).toBe("FOLDER_NOT_FOUND")
  })

  it("id sai định dạng ⇒ 404 (không 500); chuyển dự án của user khác ⇒ 404 PROJECT_NOT_FOUND", async () => {
    const owner = await seedFixture("minimal")
    const other = await seedFixture("minimal")
    const folderId = (await request(app).post("/api/v1/folders").set(as(owner)).send({ name: "A" })).body.data._id as string

    const badProject = await request(app).patch("/api/v1/projects/khong-phai-id/folder").set(as(owner)).send({ folderId })
    expect(badProject.status).toBe(404)
    expect(badProject.body.error.code).toBe("PROJECT_NOT_FOUND")
    expect((await request(app).patch("/api/v1/folders/khong-phai-id").set(as(owner)).send({ name: "x" })).status).toBe(404)
    expect((await request(app).delete("/api/v1/folders/khong-phai-id").set(as(owner))).status).toBe(404)

    const foreign = await request(app).patch(`/api/v1/projects/${other.projectId}/folder`).set(as(owner)).send({ folderId })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error.code).toBe("PROJECT_NOT_FOUND")
  })

  it("thêm nhiều dự án có sẵn: chỉ dự án của mình được chuyển, id lạ bị bỏ qua", async () => {
    const owner = await seedFixture("minimal")
    const other = await seedFixture("minimal")
    const folderId = (await request(app).post("/api/v1/folders").set(as(owner)).send({ name: "A" })).body.data._id as string
    const second = await request(app).post("/api/v1/projects").set(as(owner)).send({ name: "P2", sourceMode: "fpt_template" })

    const res = await request(app)
      .post(`/api/v1/folders/${folderId}/projects`)
      .set(as(owner))
      .send({ projectIds: [owner.projectId, second.body.data._id, other.projectId, "khong-phai-id"] })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ moved: 2 })

    const list = await request(app).get("/api/v1/folders").set(as(owner))
    expect(list.body.data[0].projectCount).toBe(2)
    const foreign = await request(app).get(`/api/v1/projects/${other.projectId}`).set(as(other))
    expect(foreign.body.data.folderId).toBeNull()

    expect((await request(app).post(`/api/v1/folders/${folderId}/projects`).set(as(other)).send({ projectIds: [other.projectId] })).status).toBe(404)
    expect((await request(app).post(`/api/v1/folders/${folderId}/projects`).set(as(owner)).send({ projectIds: [] })).status).toBe(400)
  })

  it("tạo dự án thẳng trong thư mục (một request); thư mục của user khác ⇒ 404, không tạo", async () => {
    const owner = await seedFixture("minimal")
    const other = await seedFixture("minimal")
    const folderId = (await request(app).post("/api/v1/folders").set(as(owner)).send({ name: "A" })).body.data._id as string

    const created = await request(app).post("/api/v1/projects").set(as(owner)).send({ name: "Trong A", sourceMode: "fpt_template", folderId })
    expect(created.status).toBe(201)
    expect(created.body.data.folderId).toBe(folderId)

    const rejected = await request(app).post("/api/v1/projects").set(as(other)).send({ name: "X", sourceMode: "fpt_template", folderId })
    expect(rejected.status).toBe(404)
    expect(rejected.body.error.code).toBe("FOLDER_NOT_FOUND")
    expect((await request(app).get("/api/v1/projects").set(as(other))).body.data).toHaveLength(1)
  })
})
