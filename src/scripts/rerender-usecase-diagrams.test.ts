import { describe, expect, it, vi } from "vitest"
import type { RenderResult } from "../modules/diagram/diagram.service.js"
import { RERENDER_ACTOR, RERENDER_STEP_ID, rerenderUseCaseDiagrams, type RenderFn, type RerenderTarget } from "./rerender-usecase-diagrams.js"

const TARGETS: RerenderTarget[] = [
  { projectId: "p1", diagrams: 1 },
  { projectId: "p2", diagrams: 2 }
]
const result = (rendered: string[], removed: string[] = []): RenderResult =>
  ({ spine_version: 2, diagrams: [], rendered, removed }) as unknown as RenderResult

const run = (render: RenderFn, dryRun = false) =>
  rerenderUseCaseDiagrams({ listTargets: async () => TARGETS, render }, { dryRun })

describe("rerenderUseCaseDiagrams", () => {
  it("luôn truyền force và step_id S-3.6 — thiếu một trong hai thì hoặc không compile lại, hoặc §2.2.1 thành stale", async () => {
    const render = vi.fn<RenderFn>(async () => result(["D02", "D02-2"]))
    const summary = await run(render)

    expect(render).toHaveBeenCalledTimes(2)
    expect(render).toHaveBeenCalledWith("p1", "usecase", null, { by: RERENDER_ACTOR, force: true, step_id: RERENDER_STEP_ID })
    expect(summary).toMatchObject({ projects: 2, rendered: 4, failed: 0 })
  })

  it("--dry-run không gọi renderDiagram", async () => {
    const render = vi.fn<RenderFn>(async () => result(["D02"]))
    const summary = await run(render, true)

    expect(render).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ projects: 2, rendered: 0, failed: 0 })
  })

  it("một project lỗi không làm dừng vòng lặp", async () => {
    const render = vi.fn<RenderFn>(async (projectId) => {
      if (projectId === "p1") throw new Error("PlantUML timeout")
      return result(["D02"])
    })
    const summary = await run(render)

    expect(render).toHaveBeenCalledTimes(2)
    expect(summary).toMatchObject({ projects: 2, rendered: 1, failed: 1 })
    expect(summary.rows[0].error).toContain("PlantUML timeout")
    expect(summary.rows[1].error).toBeNull()
  })
})
