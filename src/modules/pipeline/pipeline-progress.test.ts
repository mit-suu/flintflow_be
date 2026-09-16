import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine, StepState } from "../spine/spine.types.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import { buildProgressReport } from "../spine/section-status.js"
import { loadStepRegistry, orderedSteps } from "./step-registry.js"
import { buildPipelineProgressReport } from "./pipeline-progress.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const accepted = (id: string): StepState => ({ id, status: "accepted", first_seq: null, last_seq: null, accepted_at: "2026-09-01T00:00:00.000Z" })

/** Spine mới với N step đầu (theo thứ tự chạy) đã accepted và con trỏ Spine vẫn trỏ vào step thứ N — đúng trạng thái ngay sau gate accept. */
const spineAfterAccepting = (count: number): Spine => {
  const spine = createEmptySpine({ name: "Demo" })
  const ids = orderedSteps(spine).slice(0, count).map((s) => s.id)
  spine.steps = ids.map(accepted)
  spine.progress.current_step = ids[ids.length - 1] ?? null
  return spine
}

describe("buildPipelineProgressReport — current_step là step tới lượt, không phải step vừa accepted", () => {
  it("accept N step đầu ⇒ current_step = step thứ N+1 theo orderedSteps()", () => {
    const spine = spineAfterAccepting(3)
    const expected = orderedSteps(spine)[3].id
    expect(spine.progress.current_step).not.toBe(expected)
    expect(buildPipelineProgressReport(spine, []).progress.current_step).toBe(expected)
  })

  it("giữ nguyên mọi phần khác của report (readiness, sections, done/total/show_percent, current_phase)", () => {
    const spine = spineAfterAccepting(2)
    const base = buildProgressReport(spine, [])
    const report = buildPipelineProgressReport(spine, [])
    expect(report.readiness).toEqual(base.readiness)
    expect(report.sections).toEqual(base.sections)
    expect(report.progress).toEqual({ ...base.progress, current_step: orderedSteps(spine)[2].id })
  })

  it("vòng S-5 của màn placeholder bị bỏ qua: step pending của màn placeholder không phải step tới lượt", () => {
    const briefAccepted = loadStepRegistry().filter((s) => s.id.startsWith("B-")).map((s) => accepted(s.id))
    const spine: Spine = { ...FIXTURE, steps: [...FIXTURE.steps, ...briefAccepted] }
    expect(buildPipelineProgressReport(spine, []).progress.current_step).toBeNull()

    // Mở lại một step của màn thật (S05); các màn placeholder S02–S04 đứng trước trong queue vẫn bị bỏ qua
    const reopened: Spine = { ...spine, steps: spine.steps.map((s) => (s.id === "S-5.1@S05" ? { ...s, status: "pending" as const } : s)) }
    expect(FIXTURE.screens.filter((s) => ["S02", "S03", "S04"].includes(s.id)).every((s) => s.detail_status === "placeholder")).toBe(true)
    expect(buildPipelineProgressReport(reopened, []).progress.current_step).toBe("S-5.1@S05")
  })

  it("Spine không có bản ghi step Brief (fixture 19 màn) ⇒ B-0.1 — theo đúng luật nextStep(), dù con trỏ Spine ghi S-9.5", () => {
    expect(FIXTURE.progress.current_step).toBe("S-9.5")
    expect(FIXTURE.steps.some((s) => s.id.startsWith("B-"))).toBe(false)
    expect(buildPipelineProgressReport(FIXTURE, []).progress.current_step).toBe("B-0.1")
  })
})
