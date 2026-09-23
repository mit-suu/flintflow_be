/**
 * FLF-198 WP-4 — khoá step, trạng thái lượt chạy và huỷ lượt, qua HTTP trên Mongo thật.
 *
 * Ba chỗ mà lượt test UI gãy và không unit test nào bắt được, vì chúng là hành vi của **collection thật**
 * (`step_runs`) chứ không phải của hàm thuần: khoá hết hạn được, `GET /run-state` dựng lại đúng chỗ sau
 * reload, và `POST /cancel` nhả khoá ngay để chạy lại (BUG-05, BUG-07).
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { acquireRun, LOCK_TTL_MS, touchRun } from "../../src/modules/pipeline/run-state.service.js"
import { StepRun } from "../../src/modules/pipeline/run-state.model.js"

const api = (seeded: SeededFixture) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${seeded.projectId}`
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body)
  }
}

describe("run-state qua HTTP (BUG-05, BUG-07)", () => {
  it("step chưa chạy lần nào ⇒ run-state null; lượt đang chạy trả đúng stage và câu hỏi", async () => {
    const seeded = await seedFixture("minimal")
    const client = api(seeded)

    expect((await client.get("/steps/S-3.1/run-state")).body.data).toBeNull()

    const run = await acquireRun(seeded.projectId, "S-3.1", { sessionId: seeded.sessionId, by: seeded.userId })
    await touchRun(seeded.projectId, "S-3.1", run.run_id, {
      status: "waiting_answer",
      stage: "ask",
      detail_vi: "Chờ bạn trả lời 2 câu",
      questions: [
        { id: "Q1", text: "Actor chính là ai?" },
        { id: "Q2", text: "Ai duyệt?" }
      ]
    })

    const state = (await client.get("/steps/S-3.1/run-state")).body.data
    expect(state).toMatchObject({ step_id: "S-3.1", status: "waiting_answer", stage: "ask", alive: true })
    expect(state.questions).toHaveLength(2)

    const active = (await client.get("/run-state/active")).body.data
    expect(active.step_id).toBe("S-3.1")
  })

  it("huỷ lượt nhả khoá ngay: lượt mới chiếm được, và run-state báo cancelled", async () => {
    const seeded = await seedFixture("minimal")
    const client = api(seeded)
    const run = await acquireRun(seeded.projectId, "S-3.1", { by: seeded.userId })

    // Khoá đang giữ ⇒ lượt thứ hai bị từ chối
    await expect(acquireRun(seeded.projectId, "S-3.1", { by: seeded.userId })).rejects.toMatchObject({ code: "STEP_NOT_RUNNABLE" })

    const cancelled = await client.post("/steps/S-3.1/cancel")
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.data).toMatchObject({ cancelled: true, run_id: run.run_id })
    expect((await client.get("/steps/S-3.1/run-state")).body.data.status).toBe("cancelled")

    await expect(acquireRun(seeded.projectId, "S-3.1", { by: seeded.userId })).resolves.toMatchObject({ status: "running" })
  })

  it("lượt chết giữa chừng (hết heartbeat) ⇒ khoá tự hết hạn, run-state báo không còn sống", async () => {
    const seeded = await seedFixture("minimal")
    const client = api(seeded)
    const run = await acquireRun(seeded.projectId, "S-3.1", { by: seeded.userId })

    // Giả lập tiến trình chết: khoá quá hạn mà status vẫn "running"
    await StepRun.updateOne({ step_id: "S-3.1", run_id: run.run_id }, { $set: { locked_until: new Date(Date.now() - LOCK_TTL_MS) } })

    const state = (await client.get("/steps/S-3.1/run-state")).body.data
    expect(state).toMatchObject({ status: "running", alive: false })
    await expect(acquireRun(seeded.projectId, "S-3.1", { by: seeded.userId })).resolves.toMatchObject({ status: "running" })
  })

  it("giai đoạn không còn bước nào ⇒ luồng SSE đóng ngay, không treo client", async () => {
    const seeded = await seedFixture("minimal")
    // `S-9` không phải giai đoạn đang tới lượt ⇒ runner trả về ngay, không phát sự kiện nào. Trước đây
    // response chỉ được đóng khi đã phát ít nhất một sự kiện, nên client chờ mãi ở trạng thái "đang chạy".
    const spine = await request(app).get(`/api/v1/projects/${seeded.projectId}/spine`).set({ Authorization: `Bearer ${seeded.token}` })
    const res = await api(seeded)
      .post("/phases/S-9/run", { session_id: seeded.sessionId, base_version: spine.body.data.spine_version })
      .timeout(10_000)
    expect(res.status).toBe(200)
    expect(res.text).toBe("")
  })

  it("BUG-31: tài liệu chưa ghép ⇒ 200 not_assembled, không phải 409", async () => {
    const seeded = await seedFixture("minimal")
    const doc = await api(seeded).get("/document?source=draft")
    expect(doc.status).toBe(200)
    expect(doc.body.data).toBeNull()
    expect(doc.body.meta).toEqual({ state: "not_assembled", hint: "S-8.2" })
  })
})
