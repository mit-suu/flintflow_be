/**
 * Kế hoạch step theo template (#32–#33, mode 1 v2 — FLF-183) trên Mongo thật: finalize seed step, GET/PATCH step-plan,
 * `GET /steps` ẩn step skipped, chạy step skipped bị chặn, đầu mục FPT không tắt được.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { seedFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1, mode1Api } from "../../helpers/mode1.js"
import { importedProject } from "../../helpers/mode1-release-p4.js"
import { stepPlanResponseSchema } from "../../../src/modules/import/import.dto.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { ChatSession } from "../../../src/modules/project/chat-session.model.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = (p) => fakeMode1(p)
})

const plan = (res: { status: number; body: { data: unknown; error: unknown } }) => {
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return stepPlanResponseSchema.parse(res.body.data).steps
}

describe("step-plan (#32–#33)", () => {
  it("chưa finalize ⇒ 409 IMPORT_INVALID_STATE", async () => {
    const seeded = await seedFixture("minimal")
    const c = mode1Api(seeded, await createMode1Project(seeded))
    const res = await c.get("/step-plan")
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("IMPORT_INVALID_STATE")
  })

  it("sau finalize: Brief ẩn, đầu mục FPT applied; GET /steps không có step skipped", async () => {
    const { c, projectId } = await importedProject()
    const steps = plan(await c.get("/step-plan"))
    expect(steps.find((s) => s.step_id === "B-0.1")).toMatchObject({ state: "hidden" })
    expect(steps.filter((s) => s.section_ids.length && s.step_id !== "S-8.3").every((s) => s.state === "applied")).toBe(true)
    expect(steps.some((s) => s.missing)).toBe(true)

    const listed = (await c.get("/steps")).body.data.steps as { id: string; status: string }[]
    expect(listed.some((s) => s.id === "B-0.1")).toBe(false)
    expect(listed.some((s) => s.status === "skipped")).toBe(false)
    const spine = (await spineRepository.get(projectId))!
    const skipped = new Set(spine.steps.filter((s) => s.status === "skipped").map((s) => s.id))
    expect(skipped.size).toBeGreaterThan(0)
    expect(listed.filter((s) => skipped.has(s.id))).toEqual([])
  })

  it("step skipped không chạy được ⇒ 409 STEP_NOT_RUNNABLE", async () => {
    const { c, projectId } = await importedProject()
    const session = await ChatSession.create({ projectId, messages: [], is_pipeline: true })
    const res = await c.post("/steps/B-0.1/run", { session_id: String(session._id), base_version: await c.spineVersion() })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("STEP_NOT_RUNNABLE")
  })

  it("bật Brief ⇒ enabled + step pending, hiện ở /steps; tắt lại ⇒ hidden + skipped", async () => {
    const { c, projectId } = await importedProject()
    const on = plan(await c.patch("/step-plan", { step_id: "B-0.1", enabled: true }))
    expect(on.find((s) => s.step_id === "B-0.1")).toMatchObject({ state: "enabled", reason: "Người dùng bật thêm" })
    expect((await spineRepository.get(projectId))!.steps.find((s) => s.id === "B-0.1")?.status).toBe("pending")
    expect(((await c.get("/steps")).body.data.steps as { id: string }[]).some((s) => s.id === "B-0.1")).toBe(true)

    const off = plan(await c.patch("/step-plan", { step_id: "B-0.1", enabled: false }))
    expect(off.find((s) => s.step_id === "B-0.1")?.state).toBe("hidden")
    expect((await spineRepository.get(projectId))!.steps.find((s) => s.id === "B-0.1")?.status).toBe("skipped")
    // bật lại lần nữa vẫn được (không có dữ liệu)
    plan(await c.patch("/step-plan", { step_id: "B-0.1", enabled: true }))
  })

  it("tắt step đầu mục FPT ⇒ 409 CORE_STEP_REQUIRED; step lạ ⇒ 404 STEP_NOT_IN_PLAN; body sai ⇒ 400", async () => {
    const { c } = await importedProject()
    const core = await c.patch("/step-plan", { step_id: "S-7.1", enabled: false })
    expect(core.status).toBe(409)
    expect(core.body.error.code).toBe("CORE_STEP_REQUIRED")
    const unknown = await c.patch("/step-plan", { step_id: "S-99.9", enabled: true })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe("STEP_NOT_IN_PLAN")
    expect((await c.patch("/step-plan", { step_id: "", enabled: true })).status).toBe(400)
    // bật step đã applied ⇒ không đổi gì
    const same = plan(await c.patch("/step-plan", { step_id: "S-7.1", enabled: true }))
    expect(same.find((s) => s.step_id === "S-7.1")?.state).toBe("applied")
  })
})
