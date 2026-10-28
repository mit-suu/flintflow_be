/**
 * FLF-337 — mức duyệt 3 tầng qua HTTP trên Mongo thật: đổi mức duyệt bằng endpoint riêng, danh sách "không hỏi lại", sổ thay
 * đổi tự qua kèm "chưa xem" theo từng người; và mức "Chỉ ở mốc chốt" sau baseline: CR qua kiểm tự ghi vào bản nháp.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"
vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())
import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { crToReady, importedProject, newCr, detail, resetCrMock, PERF_TARGETS, type Mode1Client } from "../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose } from "../helpers/mode1.js"
import { recordAutoPass } from "../../src/modules/pipeline/auto-pass.service.js"
import { AutoPass } from "../../src/modules/pipeline/auto-pass.model.js"
import { ChangeRequest } from "../../src/modules/change-request/change-request.model.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"

const api = (seeded: SeededFixture, projectId: string) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${projectId}`
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    patch: (suffix: string, body: object = {}) => request(app).patch(`${base}${suffix}`).set(auth).send(body)
  }
}

describe("FLF-337 mức duyệt qua HTTP", () => {
  it("PATCH /review-mode: nhận milestones, ghi vào Spine project.review_mode qua op engine; giá trị lạ ⇒ 400", async () => {
    const seeded = await seedFixture("minimal")
    const c = api(seeded, seeded.projectId)
    const res = await c.patch("/review-mode", { review_mode: "milestones" })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data).toMatchObject({ review_mode: "milestones" })
    const spine = await spineRepository.get(seeded.projectId)
    expect(spine?.project.review_mode).toBe("milestones")
    expect(spine?.spine_version).toBe(res.body.data.spine_version)
    expect((await c.patch("/review-mode", { review_mode: "confident" })).status).toBe(400)
  })

  it("PATCH /skip-confirm-sections: thêm rồi gỡ; thiếu cả add lẫn remove ⇒ 400; Spine cũ không có field vẫn đọc ra []", async () => {
    const seeded = await seedFixture("minimal")
    const c = api(seeded, seeded.projectId)
    expect((await c.get("/spine")).body.data.project.skip_confirm_sections ?? []).toEqual([])
    const added = await c.patch("/skip-confirm-sections", { add: ["fixed:5", "fixed:3.1.5"] })
    expect(added.status, JSON.stringify(added.body.error)).toBe(200)
    expect(added.body.data.skip_confirm_sections).toEqual(["fixed:5", "fixed:3.1.5"])
    const removed = await c.patch("/skip-confirm-sections", { remove: ["fixed:5"] })
    expect(removed.body.data.skip_confirm_sections).toEqual(["fixed:3.1.5"])
    expect((await spineRepository.get(seeded.projectId))?.project.skip_confirm_sections).toEqual(["fixed:3.1.5"])
    expect((await c.patch("/skip-confirm-sections", {})).status).toBe(400)
  })

  it("GET /auto-passed đếm chưa xem theo người gọi; POST /seen từng cái rồi tất cả", async () => {
    const seeded = await seedFixture("minimal")
    const c = api(seeded, seeded.projectId)
    await recordAutoPass(seeded.projectId, "S-2.1", "Bước không có gì cần bạn quyết")
    await recordAutoPass(seeded.projectId, "S-2.2", "Chỉ ở mốc chốt: bước này tự qua")
    const list = (await c.get("/auto-passed")).body.data
    expect(list).toMatchObject({ total: 2, unseen: 2 })
    expect(list.items.map((i: { step_id: string }) => i.step_id)).toEqual(["S-2.2", "S-2.1"])
    expect(list.items[0].label_vi.length).toBeGreaterThan(0)

    const one = await c.post("/auto-passed/seen", { ids: [list.items[0].id] })
    expect(one.body.data).toEqual({ unseen: 1 })
    expect((await c.get("/auto-passed")).body.data.items.map((i: { seen: boolean }) => i.seen)).toEqual([true, false])

    expect((await c.post("/auto-passed/seen")).body.data).toEqual({ unseen: 0 })
    expect((await AutoPass.countDocuments({ seen_by: seeded.userId })).valueOf()).toBe(2)
  })
})

describe("FLF-337 sau baseline — Chỉ ở mốc chốt: CR qua kiểm tự ghi vào bản nháp", () => {
  // C-5: kiểm AI không có nhận xét ⇒ đủ điều kiện tự ghi (có nhận xét thì để BA xem)
  beforeEach(() => resetCrMock((p) => (p.includes("# CR Consistency") ? JSON.stringify({ findings: [] }) : fakeCrClarify(PERF_TARGETS)(p) ?? fakeCrPropose(p))))

  const asMilestones = async (c: Mode1Client) => {
    const res = await c.patch("/review-mode", { review_mode: "milestones" })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  }

  it("milestones: verify đạt ⇒ CR thành written ngay (không cần BA bấm xác nhận), ghi sổ tự qua C-6; mức khác giữ ready_to_submit", async () => {
    // Mức mặc định: dừng ở ready_to_submit như FLF-330 (dự án riêng — CR đó còn giữ khoá phần tử)
    const ready = await crToReady((await importedProject()).c)
    expect(ready.verified.change_request.status).toBe("ready_to_submit")

    const { c: client, projectId } = await importedProject()
    await asMilestones(client)
    expect((await client.get("/spine")).body.data.project.review_mode).toBe("milestones")
    const crId = await newCr(client)
    const cr = `/change-requests/${crId}`
    expect(detail(await client.post(`${cr}/clarify`)).change_request.status).toBe("impact_review")
    detail(await client.post(`${cr}/impact`))
    detail(await client.post(`${cr}/propose`))
    const verified = detail(await client.post(`${cr}/verify`))
    expect(verified.change_request.status).toBe("written")
    // cr_id đếm theo dự án — dự án A cũng có CR-001
    expect((await ChangeRequest.findOne({ projectId, cr_id: crId }).lean())?.status).toBe("written")

    const passed = (await client.get("/auto-passed")).body.data
    expect(passed.unseen).toBe(1)
    expect(passed.items[0]).toMatchObject({ step_id: `C-6:${crId}`, seen: false })
    expect(passed.items[0].label_vi).toContain(crId)
  })
})
