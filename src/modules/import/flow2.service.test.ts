import { describe, expect, it } from "vitest"
import { loadStepRegistry } from "../pipeline/step-registry.js"
import type { StepState } from "../spine/spine.types.js"
import { flow2StepOps } from "./flow2.service.js"

const state = (id: string, status: StepState["status"]): StepState => ({ id, status, first_seq: null, last_seq: null, accepted_at: null })

describe("flow2StepOps — chế độ 3 sang Luồng 2 tại 2.4", () => {
  it("mở lại Brief B-1…S-1 (đang bỏ qua), giữ B-0 bỏ qua, giữ bước đã chốt / bước mục thiếu; bước kế tiếp là B-1.1", () => {
    const registry = loadStepRegistry().filter((s) => s.kind !== "loop")
    const steps = registry.map((s) =>
      state(s.id, s.phase.startsWith("B-") || s.phase === "S-1" ? "skipped" : s.id === "S-2.1" ? "accepted" : s.id === "S-2.2" ? "pending" : "skipped")
    )
    const ops = flow2StepOps({ steps, screens: [], functions: [] })
    const reopened = ops.filter((o) => o.path.startsWith("steps[")).map((o) => o.path)
    expect(reopened).toContain("steps[id=B-1.1].status")
    expect(reopened).toContain("steps[id=B-2.3].status")
    expect(reopened).toContain("steps[id=S-1.1].status")
    expect(reopened.some((p) => p.startsWith("steps[id=B-0."))).toBe(false)
    expect(reopened.some((p) => p.includes("S-2."))).toBe(false)
    expect(ops.find((o) => o.path === "progress.current_step")?.value).toBe("B-1.1")
    expect(ops.find((o) => o.path === "progress.current_phase")?.value).toBe("B-1")
  })

  it("FLF-378: bước sở hữu mục mẫu đang accepted / skipped ⇒ pending (bỏ mốc chốt), id mẫu S-5 áp mọi vòng; bước khác giữ nguyên", () => {
    const registry = loadStepRegistry().filter((s) => s.kind !== "loop")
    const steps = [
      ...registry.map((s) => ({
        ...state(s.id, s.phase.startsWith("B-") || s.phase === "S-1" ? "skipped" : s.id === "S-2.1" ? "accepted" : s.id === "S-7.1" ? "skipped" : "accepted"),
        ...(s.id === "S-2.1" ? { first_seq: 1, last_seq: 5, accepted_at: "2026-11-01T00:00:00.000Z" } : {})
      })),
      state("S-5.2@S01", "accepted"),
      state("S-5.3@S01", "accepted")
    ]
    const ops = flow2StepOps({ steps, screens: [], functions: [] }, ["S-2.1", "S-7.1", "S-5.2"])
    const set = (path: string) => ops.find((o) => o.path === path)?.value
    expect(set("steps[id=S-2.1].status")).toBe("pending")
    expect(set("steps[id=S-2.1].accepted_at")).toBeNull()
    expect(set("steps[id=S-2.1].last_seq")).toBeNull()
    expect(set("steps[id=S-7.1].status")).toBe("pending")
    expect(set("steps[id=S-5.2@S01].status")).toBe("pending")
    expect(ops.some((o) => o.path.startsWith("steps[id=S-5.3@S01]"))).toBe(false)
    expect(ops.some((o) => o.path.startsWith("steps[id=S-3.1]"))).toBe(false)
    expect(set("progress.current_step")).toBe("B-1.1")
  })
})

