/**
 * flags (T22) — endpoint 2, 12, 13, 14 qua HTTP trên Mongo thật: recompute, waive, progress.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { flagsResponseSchema, progressResponseSchema } from "../../src/modules/pipeline/pipeline.dto.js"
import { NON_WAIVABLE_RULES } from "../../src/modules/spine/deterministic-check.js"

const api = (seeded: SeededFixture) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${seeded.projectId}`
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body)
  }
}

describe("deterministic check qua HTTP", () => {
  it("fixture 19 màn ⇒ 0 cờ (điều kiện M2); progress.current_step là step tới lượt theo nextStep(), không cờ đỏ", async () => {
    const seeded = await seedFixture("full")
    const client = api(seeded)

    const recompute = await client.post("/flags/recompute")
    expect(recompute.status).toBe(200)
    const flags = flagsResponseSchema.parse(recompute.body.data)
    // FLF-198: fixture có 14 màn `placeholder` và một function nền chưa gắn use case ⇒ cờ VÀNG nhắc việc
    // (waive được, không chặn ký). Điều kiện M2 vẫn là: không cờ đỏ nào.
    expect(flags.filter((f) => f.level === "red")).toHaveLength(0)
    expect([...new Set(flags.map((f) => f.rule_id))].sort()).toEqual(["function_without_uc", "screen_placeholder"])

    const progress = await client.get("/progress")
    expect(progress.status).toBe(200)
    const parsed = progressResponseSchema.parse(progress.body.data)
    expect(parsed.readiness.red_open).toBe(0)
    // Con trỏ Spine của fixture ghi S-9.5 (đã accepted) nhưng fixture không có bản ghi 13 step Brief,
    // nên step tới lượt theo nextStep() là B-0.1 — `current_step` không còn trỏ vào step đã accepted.
    expect(parsed.progress.current_step).toBe("B-0.1")
  })

  it("fixture minimal ⇒ cờ đỏ mở; GET /flags lọc level/open khớp; recompute lần hai không mở trùng", async () => {
    const seeded = await seedFixture("minimal")
    const client = api(seeded)

    const first = await client.post("/flags/recompute")
    const opened = flagsResponseSchema.parse(first.body.data)
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every((f) => f.level === "red")).toBe(true)

    const red = await client.get("/flags?level=red&open=true")
    expect(red.status).toBe(200)
    expect(flagsResponseSchema.parse(red.body.data)).toHaveLength(opened.length)
    const yellow = await client.get("/flags?level=yellow")
    expect(flagsResponseSchema.parse(yellow.body.data)).toHaveLength(0)

    const second = await client.post("/flags/recompute")
    expect(second.body.meta.opened).toEqual([])
    expect(flagsResponseSchema.parse(second.body.data)).toHaveLength(opened.length)

    const progress = progressResponseSchema.parse((await client.get("/progress")).body.data)
    expect(progress.readiness.red_open).toBe(opened.length)
  })

  it("cờ không được waive (array_empty) ⇒ 400 FLAG_NOT_WAIVABLE; id lạ ⇒ 404 FLAG_NOT_FOUND", async () => {
    const seeded = await seedFixture("minimal")
    const client = api(seeded)
    const flags = flagsResponseSchema.parse((await client.post("/flags/recompute")).body.data)
    const blocked = flags.find((f) => NON_WAIVABLE_RULES.has(f.rule_id))
    expect(blocked, "fixture minimal phải có cờ array_empty").toBeDefined()

    const reason = "Integration test: accepted risk for this release."
    const res = await client.post(`/flags/${blocked!.id}/waive`, { reason })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("FLAG_NOT_WAIVABLE")

    const missing = await client.post("/flags/FL999/waive", { reason })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe("FLAG_NOT_FOUND")
  })

  it("nội dung không phải tiếng Anh ⇒ cờ vàng non_english_content; waive cần lý do ≥ 20 ký tự; sửa lại ⇒ cờ đóng", async () => {
    const seeded = await seedFixture("full")
    const client = api(seeded)

    const setDescription = async (baseVersion: number, description: string) => {
      const res = await client.post("/changes", {
        base_version: baseVersion,
        ops: [{ op: "set", path: "actors[id=A01].description", value: description, reason: "integration test" }]
      })
      expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    }
    const currentVersion = async () => (await client.get("/spine")).body.data.spine_version as number

    await setDescription(seeded.spineVersion, "Người sáng lập khởi nghiệp, người viết tài liệu yêu cầu phần mềm qua hệ thống.")
    const flags = flagsResponseSchema.parse((await client.post("/flags/recompute")).body.data)
    const yellow = flags.find((f) => f.rule_id === "non_english_content" && f.resolved_at === null)
    expect(yellow, JSON.stringify(flags)).toBeDefined()
    expect(yellow!.level).toBe("yellow")

    const tooShort = await client.post(`/flags/${yellow!.id}/waive`, { reason: "ok" })
    expect(tooShort.status).toBe(400)
    expect(tooShort.body.error.code).toBe("VALIDATION_ERROR")

    const waived = await client.post(`/flags/${yellow!.id}/waive`, { reason: "Customer requires the Vietnamese persona name." })
    expect(waived.status, JSON.stringify(waived.body.error)).toBe(200)
    expect(waived.body.data.waived_by_user).toBe(true)

    await setDescription(await currentVersion(), "Startup founder who authors the SRS through the guided pipeline.")
    const after = flagsResponseSchema.parse((await client.post("/flags/recompute")).body.data)
    const closed = after.find((f) => f.id === yellow!.id)
    expect(closed?.resolved_at).not.toBeNull()
  })
})
