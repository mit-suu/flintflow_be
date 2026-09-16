/**
 * measure-tokens (T22) — driver của `src/scripts/measure-tokens.ts` ở chế độ estimate trên Mongo thật:
 * đo được prompt thật của vài step đầu, không ghi Usage/credit, dọn sạch dữ liệu tạm.
 */
import { describe, it, expect } from "vitest"
import { measure, parseArgs, renderReport } from "../../src/scripts/measure-tokens.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Spine } from "../../src/modules/spine/spine.model.js"
import { Usage } from "../../src/modules/spine/usage.model.js"

describe("measure() chế độ estimate", () => {
  it("B-0.1…B-1.2 trên fixture minimal: mỗi step 1 elicit + 1 draft, token in > 0, không tốn credit thật, dọn dữ liệu", { timeout: 120_000 }, async () => {
    const options = { ...parseArgs(["--fixture", "minimal", "--no-write"]), limitSteps: 6 }
    const result = await measure(options, () => {})

    expect(result.stepOrder).toEqual(["B-0.1", "B-0.2", "B-0.3", "B-0.4", "B-1.1", "B-1.2"])
    expect(result.records.filter((r) => r.error)).toEqual([])
    for (const stepId of result.stepOrder) {
      const calls = result.records.filter((r) => r.step_id === stepId)
      expect(calls.map((c) => c.call_kind).sort(), stepId).toEqual(["draft", "elicit"])
      expect(calls.every((c) => c.tokens_in > 500 && !c.measured), stepId).toBe(true)
    }

    // Không gọi provider ⇒ không có Usage; project tạm đã xoá
    expect(await Usage.countDocuments({})).toBe(0)
    expect(await Project.countDocuments({})).toBe(0)
    expect(await Spine.countDocuments({})).toBe(0)

    const report = renderReport({
      options,
      ...result,
      startedAt: new Date(),
      durationMs: 1,
      thresholds: { credit_per_project: null, usd_per_project: null, tokens_in_per_call: null }
    })
    expect(report).toContain("| **Tổng** | **6** | **12 (6 + 6)**")
  })
})
