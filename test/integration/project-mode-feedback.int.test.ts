/**
 * `POST /projects` nhận `mode` (mặc định fpt, customer_template ⇒ 501), mở dự án ghi `lastOpenedAt`; góp ý member gửi qua
 * `POST /feedback` hiện ở `GET /admin/feedback` — qua HTTP trên Mongo thật.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"
import { User } from "../../src/modules/user/user.model.js"

const as = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })

describe("project mode qua HTTP", () => {
  it("mode lạ ⇒ 400 VALIDATION_ERROR, customer_template ⇒ 501 NOT_IMPLEMENTED, không tạo dự án", async () => {
    const seeded = await seedFixture("minimal")

    const invalid = await request(app).post("/api/v1/projects").set(as(seeded)).send({ name: "Lumen", mode: "coaching" })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR")

    const unsupported = await request(app).post("/api/v1/projects").set(as(seeded)).send({ name: "Lumen", mode: "customer_template" })
    expect(unsupported.status).toBe(501)
    expect(unsupported.body.error.code).toBe("NOT_IMPLEMENTED")

    const list = await request(app).get("/api/v1/projects").set(as(seeded))
    expect(list.body.data).toHaveLength(1) // chỉ dự án của fixture
  })

  it("tạo fpt (mặc định) và import ⇒ 201, GET /projects/:id trả đúng mode", async () => {
    const seeded = await seedFixture("minimal")

    for (const [body, mode] of [[{ name: "P fpt" }, "fpt"], [{ name: "P import", mode: "import" }, "import"]] as const) {
      const created = await request(app).post("/api/v1/projects").set(as(seeded)).send(body)
      expect(created.status).toBe(201)
      expect(created.body.data.mode).toBe(mode)

      const one = await request(app).get(`/api/v1/projects/${created.body.data._id}`).set(as(seeded))
      expect(one.body.data.mode).toBe(mode)
    }
  })
})

describe("mở dự án", () => {
  it("GET /projects/:id ghi lastOpenedAt, không đổi updatedAt; id sai định dạng ⇒ 404", async () => {
    const seeded = await seedFixture("minimal")
    const before = await request(app).get("/api/v1/projects").set(as(seeded))
    const listed = before.body.data[0]
    expect(listed.lastOpenedAt ?? null).toBeNull()

    const opened = await request(app).get(`/api/v1/projects/${seeded.projectId}`).set(as(seeded))
    expect(opened.status).toBe(200)
    expect(opened.body.data.lastOpenedAt).toEqual(expect.any(String))
    expect(opened.body.data.updatedAt).toBe(listed.updatedAt)

    const bad = await request(app).get("/api/v1/projects/khong-phai-id").set(as(seeded))
    expect(bad.status).toBe(404)
  })
})

describe("feedback", () => {
  it("member gửi góp ý ⇒ admin đọc được, mới nhất trước, kèm người gửi", async () => {
    const seeded = await seedFixture("minimal")
    const admin = await User.create({ email: "admin@flintflow.test", password: "admin-password-123", name: "Admin", role: "admin", emailVerified: true })
    const adminToken = await authAs({ _id: admin._id, email: admin.email, role: "admin" })

    expect((await request(app).post("/api/v1/feedback").send({ category: "bug", message: "x" })).status).toBe(401)
    const invalid = await request(app).post("/api/v1/feedback").set(as(seeded)).send({ category: "bug", message: "  " })
    expect(invalid.status).toBe(400)

    const first = await request(app).post("/api/v1/feedback").set(as(seeded)).send({ category: "bug", message: "Nút lưu không chạy" })
    expect(first.status).toBe(201)
    await request(app).post("/api/v1/feedback").set(as(seeded)).send({ category: "suggestion", message: "Thêm dark mode" })

    const res = await request(app).get("/api/v1/admin/feedback").set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.meta.total).toBe(2)
    expect(res.body.data.map((f: { message: string }) => f.message)).toEqual(["Thêm dark mode", "Nút lưu không chạy"])
    expect(res.body.data[0].user).toMatchObject({ _id: seeded.userId, name: "Fixture User" })
  })
})
