/**
 * CORS qua `app` thật: FE tải `.docx` bằng `fetch` nên chỉ đọc được tên file trong `Content-Disposition`
 * khi BE gửi `Access-Control-Expose-Headers` (spec-gaps FLF-164).
 *
 * Không kiểm whitelist origin ở đây: `NODE_ENV=test` (test/setup.ts) đi nhánh non-production của
 * `src/app.ts` — mọi origin đều được cho qua, assertion về whitelist sẽ vô nghĩa.
 */
import { describe, expect, it } from "vitest"
import request from "supertest"
import app from "../../src/app.js"

const ORIGIN = "http://localhost:3000"

describe("CORS — Access-Control-Expose-Headers", () => {
  it("response có Origin ⇒ expose Content-Disposition để FE đọc được tên file tải về", async () => {
    const res = await request(app).get("/health").set("Origin", ORIGIN)

    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN)
    expect(res.headers["access-control-expose-headers"]).toContain("Content-Disposition")
  })

  it("middleware chạy trước mọi route ⇒ cả response lỗi (401) cũng expose header", async () => {
    const res = await request(app).get("/api/v1/projects").set("Origin", ORIGIN)

    expect(res.status).toBe(401)
    expect(res.headers["access-control-expose-headers"]).toContain("Content-Disposition")
  })
})
