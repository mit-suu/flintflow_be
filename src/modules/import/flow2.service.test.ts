import { describe, expect, it } from "vitest"
import { loadStepRegistry } from "../pipeline/step-registry.js"
import type { StepState } from "../spine/spine.types.js"
import { flow2Owners, flow2StepOps } from "./flow2.service.js"

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

  it("SRS đã viết: bước sở hữu mục khách viết không bao giờ mở lại (kể cả khi cũng sở hữu mục thiếu); bước giữ chốt còn pending ⇒ accepted với mốc của lô import", () => {
    const steps = [
      state("B-1.1", "skipped"),
      { ...state("S-2.1", "accepted"), first_seq: 3, last_seq: 9, accepted_at: "2026-11-01T00:00:00.000Z" },
      state("S-3.6", "pending"),
      state("S-8.1", "skipped"),
      state("S-5.2@S01", "accepted"),
      state("S-5.2@S02", "accepted")
    ]
    const ops = flow2StepOps({ steps, screens: [], functions: [] }, ["S-8.1", "S-5.2", "S-7.1"], ["S-2.1", "S-3.6", "S-8.1", "S-5.2@S01"], "2026-11-08T00:00:00.000Z")
    const set = (path: string) => ops.find((o) => o.path === path)?.value
    // S-8.1 sở hữu cả mục riêng đã viết lẫn mục riêng còn thiếu ⇒ giữ nguyên
    expect(ops.some((o) => o.path.startsWith("steps[id=S-8.1]"))).toBe(false)
    // Vòng S-5: màn đã viết giữ chốt, màn khác soạn lại
    expect(ops.some((o) => o.path.startsWith("steps[id=S-5.2@S01]"))).toBe(false)
    expect(set("steps[id=S-5.2@S02].status")).toBe("pending")
    // Bước giữ chốt mà lúc import chưa trích được dữ liệu ⇒ chốt luôn, mốc seq như bước chốt lúc import
    expect(set("steps[id=S-3.6].status")).toBe("accepted")
    expect(set("steps[id=S-3.6].last_seq")).toBe(9)
    expect(set("steps[id=S-3.6].accepted_at")).toBe("2026-11-08T00:00:00.000Z")
    expect(ops.some((o) => o.path.startsWith("steps[id=S-2.1]"))).toBe(false)
  })
})

describe("flow2Owners — bước cần soạn / bước giữ chốt", () => {
  const sections = [
    { section_id: "fixed:1", title: "1 Overview", status: "present" as const, owner_steps: ["S-2.1"] },
    { section_id: "fixed:2.1", title: "2.1 Actors", status: "missing" as const, owner_steps: ["S-3.1"] },
    { section_id: "custom:CS01", title: "Team Notes", status: "present" as const, owner_steps: ["S-8.1"] },
    { section_id: "custom:CS02", title: "Document Conventions", status: "missing" as const, owner_steps: ["S-8.1"] },
    { section_id: "fixed:I", title: "Record of Changes", status: "missing" as const, owner_steps: ["S-9.1"] },
    { section_id: "custom:CS03", title: "Budget", status: "out_of_scope" as const, owner_steps: [] }
  ]
  it("SRS đã viết ⇒ soạn mục thiếu, giữ chốt mục đã viết; bỏ Record of Changes / ngoài phạm vi", () => {
    // FLF-382: S-8.1 sở hữu cả mục riêng đã viết lẫn mục riêng còn trống ⇒ vẫn soạn (chỉ ghi được mục còn trống)
    expect(flow2Owners(sections, false)).toEqual({ draft: ["S-3.1", "S-8.1"], keep: ["S-2.1"] })
  })
  it("FLF-382: bước sở hữu mục FPT đã viết lẫn mục FPT còn thiếu vẫn giữ chốt (D4 — không soạn lại phần khách viết)", () => {
    const fpt = [
      { section_id: "fixed:1", title: "1 Overview", status: "present" as const, owner_steps: ["S-2.1", "S-2.2"] },
      { section_id: "slot:scope", title: "1.2 Scope", status: "missing" as const, owner_steps: ["S-2.2"] },
      { section_id: "slot:references", title: "1.4 References", status: "missing" as const, owner_steps: ["S-8.1"] },
      { section_id: "fixed:5.5", title: "Glossary", status: "present" as const, owner_steps: ["S-8.1"] }
    ]
    expect(flow2Owners(fpt, false)).toEqual({ draft: ["S-2.2", "S-8.1"], keep: ["S-2.1", "S-2.2"] })
  })
  it("khung mẫu ⇒ soạn mọi mục của mẫu, không giữ bước nào", () => {
    expect(flow2Owners(sections, true)).toEqual({ draft: ["S-2.1", "S-3.1", "S-8.1"], keep: [] })
  })
})
