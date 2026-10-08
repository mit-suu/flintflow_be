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
  it("B-0.1…B-1.3 trên fixture minimal (đo từng bước, KHÔNG gồm lượt hỏi gộp đầu B-1): B-0.1 1 elicit + 1 draft, B-1.x chỉ draft, token in > 0, không tốn credit thật, dọn dữ liệu", { timeout: 120_000 }, async () => {
    const options = { ...parseArgs(["--fixture", "minimal", "--no-write"]), limitSteps: 6 }
    const result = await measure(options, () => {})

    expect(result.stepOrder).toEqual(["B-0.1", "B-0.2", "B-0.3", "B-1.1", "B-1.2", "B-1.3"])
    expect(result.records.filter((r) => r.error)).toEqual([])
    // FLF-221: B-0.2/B-0.3: fixture đã có form_factor/stakes ⇒ lượt đầu không gọi model
    // Fast path Brief: bước B-1.x không gọi Elicit khi không có tin user mới. `measure()` chạy `runStep` từng bước nên KHÔNG đo
    // lượt hỏi gộp đầu B-1 (nằm ở `runPhase`); số elicit của B-1 ở báo cáo này vì vậy là 0, không phải chi phí thật của giai đoạn.
    const expectedKinds = (stepId: string): string[] => (["B-0.2", "B-0.3"].includes(stepId) ? [] : stepId.startsWith("B-1.") ? ["draft"] : ["draft", "elicit"])
    for (const stepId of result.stepOrder) {
      const calls = result.records.filter((r) => r.step_id === stepId)
      expect(calls.map((c) => c.call_kind).sort(), stepId).toEqual(expectedKinds(stepId))
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
    expect(report).toContain("| **Tổng** | **6** | **5 (1 + 4)**")
  })
})
