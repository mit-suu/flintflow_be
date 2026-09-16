/**
 * `GET /health` qua app thật + Mongo thật (T24).
 *
 * Harness cố tình trỏ `PLANTUML_BASE_URL` vào cổng đóng (`test/setup.ts`), nên đây cũng là lượt kiểm
 * nhánh **degraded**: PlantUML chết thì health vẫn 200, vì chặn deploy vì diagram là phản ứng thái quá.
 */
import { describe, expect, it } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { resetHealthCache } from "../../src/config/health.js"

describe("GET /health", () => {
  it("Mongo sống, PlantUML chết ⇒ 200 degraded, đủ mongo/plantuml/version/assets", async () => {
    resetHealthCache()
    const res = await request(app).get("/health")

    expect(res.status).toBe(200)
    expect(res.body.error).toBeNull()
    expect(res.body.data).toMatchObject({ status: "degraded", mongo: "ok", plantuml: "error" })
    expect(res.body.data.version).toBeTruthy()
    expect(res.body.data.assets.skills).toBeGreaterThan(0)
    expect(res.body.data.assets.steps).toBeGreaterThan(0)
  })

  it("không cần đăng nhập — health check của orchestrator không mang token", async () => {
    const res = await request(app).get("/health")
    expect(res.status).not.toBe(401)
  })
})
