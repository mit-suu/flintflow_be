/**
 * `POST /projects` bắt buộc `sourceMode` và trả lại nó ở `GET /projects`; góp ý member gửi qua
 * `POST /feedback` hiện ở `GET /admin/feedback` — qua HTTP trên Mongo thật.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"
import { User } from "../../src/modules/user/user.model.js"

const as = (seeded: SeededFixture) => ({ Authorization: `Bearer ${seeded.token}` })

describe("project sourceMode", () => {
  it("thiếu hoặc sai sourceMode ⇒ 400 VALIDATION_ERROR, không tạo dự án", async () => {
    const seeded = await seedFixture("minimal")

    for (const body of [{ name: "Lumen" }, { name: "Lumen", sourceMode: "coaching" }]) {
      const res = await request(app).post("/api/v1/projects").set(as(seeded)).send(body)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe("VALIDATION_ERROR")
    }
    const list = await request(app).get("/api/v1/projects").set(as(seeded))
    expect(list.body.data).toHaveLength(1) // chỉ dự án của fixture
  })

  it("tạo với từng mode ⇒ 201, GET /projects và GET /projects/:id trả đúng sourceMode", async () => {
    const seeded = await seedFixture("minimal")

    for (const sourceMode of ["edit_srs", "fpt_template", "customer_template"]) {
      const created = await request(app).post("/api/v1/projects").set(as(seeded)).send({ name: `P ${sourceMode}`, sourceMode })
      expect(created.status).toBe(201)
      expect(created.body.data.sourceMode).toBe(sourceMode)

      const one = await request(app).get(`/api/v1/projects/${created.body.data._id}`).set(as(seeded))
      expect(one.body.data.sourceMode).toBe(sourceMode)
    }

    const list = await request(app).get("/api/v1/projects").set(as(seeded))
    expect((list.body.data as Array<{ sourceMode: string }>).map((p) => p.sourceMode).sort()).toEqual(
      ["customer_template", "edit_srs", "fpt_template", "fpt_template"]
    )
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
