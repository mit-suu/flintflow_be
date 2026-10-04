/**
 * Câu lỗi người dùng đọc được (FLF-247) — qua app thật: route không có, JSON hỏng, lỗi Zod của body.
 * `message` không mang text thư viện / path schema; chi tiết ở `meta`.
 */
import { describe, expect, it } from "vitest"
import request from "supertest"
import app from "../../src/app.js"

describe("envelope lỗi (FLF-247)", () => {
  it("route không tồn tại ⇒ 404 JSON NOT_FOUND, không phải trang HTML của Express", async () => {
    const res = await request(app).get("/api/v1/khong-co-route-nay")
    expect(res.status).toBe(404)
    expect(res.headers["content-type"]).toMatch(/json/)
    expect(res.body).toEqual({ data: null, error: { code: "NOT_FOUND", message: "Không tìm thấy địa chỉ yêu cầu." } })
  })

  it("body JSON hỏng ⇒ 400 BAD_REQUEST với câu thường, không lộ lỗi parser", async () => {
    const res = await request(app).post("/api/v1/auth/login").set("Content-Type", "application/json").send('{"email": ')
    expect(res.status).toBe(400)
    expect(res.body.error).toEqual({ code: "BAD_REQUEST", message: "Dữ liệu gửi lên không đọc được. Vui lòng thử lại." })
  })

  it("lỗi Zod có câu do schema viết ⇒ câu đó; thiếu field (câu mặc định) ⇒ câu chung, chi tiết ở meta.issues", async () => {
    const badEmail = await request(app).post("/api/v1/auth/login").send({ email: "khong-phai-email", password: "x" })
    expect(badEmail.status).toBe(400)
    expect(badEmail.body.error).toEqual({ code: "VALIDATION_ERROR", message: "Email không hợp lệ." })
    expect(badEmail.body.meta.issues).toEqual([{ path: "email", message: "Email không hợp lệ." }])

    const missing = await request(app).post("/api/v1/auth/login").send({})
    expect(missing.status).toBe(400)
    expect(missing.body.error).toEqual({
      code: "VALIDATION_ERROR",
      message: "Dữ liệu gửi lên không hợp lệ. Vui lòng tải lại trang rồi thử lại."
    })
    expect(missing.body.meta.issues.map((i: { path: string }) => i.path).sort()).toEqual(["email", "password"])
  })
})
