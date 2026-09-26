/**
 * Kế hoạch step theo template (#32–#33, mode 1 v2 — FLF-183) trên Mongo thật: finalize seed step, GET step-plan,
 * `GET /steps` ẩn step skipped. Mode 1 v3 (BPMN Flow 1 không có step): chạy step / gate / PATCH step-plan ⇒ 409
 * `MODE1_NO_STEPS`; kế hoạch step chỉ còn dùng để xác định step sở hữu field (C-4) và gap report.
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

  it("mode 1 v3: chạy step, gate, PATCH step-plan ⇒ 409 MODE1_NO_STEPS; Spine không đổi", async () => {
    const { c, projectId } = await importedProject()
    const session = await ChatSession.create({ projectId, messages: [], is_pipeline: true })
    const version = await c.spineVersion()
    const attempts = [
      await c.post("/steps/S-7.1/run", { session_id: String(session._id), base_version: version }),
      await c.post("/steps/S-7.1/gate", { session_id: String(session._id), base_version: version, action: "accept" }),
      await c.patch("/step-plan", { step_id: "B-0.1", enabled: true })
    ]
    for (const res of attempts) {
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error.code).toBe("MODE1_NO_STEPS")
    }
    expect(await c.spineVersion()).toBe(version)
    expect((await spineRepository.get(projectId))!.steps.find((s) => s.id === "B-0.1")?.status).toBe("skipped")
  })
})
