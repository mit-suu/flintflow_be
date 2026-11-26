import { describe, expect, it } from "vitest"
import { loadStepRegistry } from "../pipeline/step-registry.js"
import type { StepState } from "../spine/spine.types.js"
import { entersFlow2, flow2Owners, flow2SkipOwners, flow2StepOps } from "./flow2.service.js"
import { templateSectionOwnerSteps } from "./template-step-headings.js"
import { inputStepsOf } from "./step-plan.js"

const state = (id: string, status: StepState["status"]): StepState => ({ id, status, first_seq: null, last_seq: null, accepted_at: null })

describe("flow2StepOps - chế độ 3 sang Luồng 2 tại 2.4", () => {
  it("FLF-461: mở lại B-0 và Brief B-1…S-1 (đang bỏ qua), giữ bước đã chốt / bước mục thiếu; bước kế tiếp là B-0.1 (phần đã có làm đầu vào, AI chỉ hỏi phần thiếu)", () => {
    const registry = loadStepRegistry().filter((s) => s.kind !== "loop")
    const steps = registry.map((s) =>
      state(s.id, s.phase.startsWith("B-") || s.phase === "S-1" ? "skipped" : s.id === "S-2.1" ? "accepted" : s.id === "S-2.2" ? "pending" : "skipped")
    )
    const ops = flow2StepOps({ steps, screens: [], functions: [] })
    const reopened = ops.filter((o) => o.path.startsWith("steps[")).map((o) => o.path)
    expect(reopened).toContain("steps[id=B-1.1].status")
    expect(reopened).toContain("steps[id=B-2.3].status")
    expect(reopened).toContain("steps[id=S-1.1].status")
    expect(reopened).toContain("steps[id=B-0.1].status")
    expect(reopened).toContain("steps[id=B-0.2].status")
    expect(reopened).toContain("steps[id=B-0.3].status")
    expect(reopened.some((p) => p.includes("S-2."))).toBe(false)
    expect(ops.find((o) => o.path === "progress.current_step")?.value).toBe("B-0.1")
    expect(ops.find((o) => o.path === "progress.current_phase")?.value).toBe("B-0")
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
    expect(set("progress.current_step")).toBe("B-0.1")
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

describe("flow2Owners - bước cần soạn / bước giữ chốt", () => {
  const sections = [
    { section_id: "fixed:1", title: "1 Overview", status: "present" as const, owner_steps: ["S-2.1"] },
    { section_id: "fixed:2.1", title: "2.1 Actors", status: "missing" as const, owner_steps: ["S-3.1"] },
    { section_id: "custom:CS01", title: "Team Notes", status: "present" as const, owner_steps: ["S-8.1"] },
    { section_id: "custom:CS02", title: "Document Conventions", status: "missing" as const, owner_steps: ["S-8.1"] },
    { section_id: "fixed:I", title: "Record of Changes", status: "missing" as const, owner_steps: ["S-9.1"] },
    { section_id: "custom:CS03", title: "Dự toán chi phí", status: "out_of_scope" as const, owner_steps: [] }
  ]
  it("SRS đã viết ⇒ soạn mục thiếu, giữ chốt mục đã viết; bỏ Record of Changes / ngoài phạm vi", () => {
    // FLF-382: S-8.1 sở hữu cả mục riêng đã viết lẫn mục riêng còn trống ⇒ vẫn soạn (chỉ ghi được mục còn trống)
    expect(flow2Owners(sections, false)).toEqual({ draft: ["S-3.1", "S-8.1"], keep: ["S-2.1"], inputs: [] })
  })
  it("FLF-382: bước sở hữu mục FPT đã viết lẫn mục FPT còn thiếu vẫn giữ chốt (D4 - không soạn lại phần khách viết)", () => {
    const fpt = [
      { section_id: "fixed:1", title: "1 Overview", status: "present" as const, owner_steps: ["S-2.1", "S-2.2"] },
      { section_id: "slot:scope", title: "1.2 Scope", status: "missing" as const, owner_steps: ["S-2.2"] },
      { section_id: "slot:references", title: "1.4 References", status: "missing" as const, owner_steps: ["S-8.1"] },
      { section_id: "fixed:5.5", title: "Glossary", status: "present" as const, owner_steps: ["S-8.1"] }
    ]
    expect(flow2Owners(fpt, false)).toEqual({ draft: ["S-2.2", "S-8.1"], keep: ["S-2.1", "S-2.2"], inputs: [] })
  })
  it("khung mẫu ⇒ soạn mọi mục của mẫu, không giữ bước nào", () => {
    expect(flow2Owners(sections, true)).toEqual({ draft: ["S-2.1", "S-3.1", "S-8.1"], keep: [], inputs: [] })
  })
})

describe("entersFlow2 - file còn thiếu cấu trúc đích sang Luồng 2 (FLF-416)", () => {
  it("giữ khung thiếu (chế độ 3) và tick bổ sung theo mẫu chuẩn còn thiếu (chế độ 4) ⇒ sang Luồng 2", () => {
    expect(entersFlow2("fixed", 3)).toBe(true)
    expect(entersFlow2("free", 4)).toBe(true)
  })
  it("đủ cấu trúc đích (chế độ 1), ý định lệch chế độ, dự án cũ không ý định ⇒ không", () => {
    expect(entersFlow2("fixed", 1)).toBe(false)
    expect(entersFlow2("free", 1)).toBe(false)
    expect(entersFlow2("free", 3)).toBe(false)
    expect(entersFlow2("fixed", 4)).toBe(false)
    expect(entersFlow2(null, 4)).toBe(false)
  })
})

describe("flow2Owners - chế độ 4 (đích = mẫu chuẩn FlintFlow)", () => {
  it("soạn bước của mục FPT còn thiếu; giữ bước của mục có sẵn; mục Ngoài phạm vi không có bước", () => {
    const { draft, keep } = flow2Owners([
      { section_id: "fixed:II.1", title: "Product Overview", status: "present", owner_steps: ["S-1.1"] },
      { section_id: "fixed:V.5", title: "Glossary", status: "missing", owner_steps: ["S-8.3"] },
      { section_id: "custom:c1", title: "Cost", status: "out_of_scope", owner_steps: [] }
    ], false)
    expect(draft).toEqual(["S-8.3"])
    expect(keep).toEqual(["S-1.1"])
  })
})

describe("FLF-461 lọc step chế độ 3/4 - giữ bước cung cấp đầu vào", () => {
  it("mẫu không có Screen Layout (S-5.3) vẫn giữ Screen Inventory (S-4.1) và Actor (S-3.1) cho vòng soạn theo màn", () => {
    // Mẫu có chức năng theo màn (S-5.2, S-5.4) nhưng không có mục Screen Layout, không có mục Screen Inventory
    const owners = ["S-5.2", "S-5.4"]
    expect(owners).not.toContain("S-5.3")
    const inputs = inputStepsOf(owners)
    expect(inputs).toContain("S-4.1")
    expect(inputs).toContain("S-3.1")
    expect(inputs).not.toContain("S-5.3")
    expect(inputs).not.toContain("S-5.2")
  })

  it("id vòng S-5 mang @màn vẫn tính; bước đã là bước soạn không lặp lại trong đầu vào", () => {
    expect(inputStepsOf(["S-5.2@SCR-01"])).toContain("S-4.1")
    expect(inputStepsOf(["S-4.1", "S-5.2"])).toEqual(["S-3.1"])
    expect(inputStepsOf(["S-2.1"])).toEqual([])
  })

  it("flow2Owners: bước đầu vào không nằm trong bước giữ chốt (mục khách đã viết)", () => {
    const sections = [{ section_id: "feature:F1", title: "Feature", status: "missing" as const, owner_steps: ["S-5.2", "S-5.4"] }]
    expect(flow2Owners(sections, false).inputs).toEqual(["S-3.1", "S-4.1"])
    const withKeep = [...sections, { section_id: "fixed:4.1", title: "Screens", status: "present" as const, owner_steps: ["S-4.1"] }]
    expect(flow2Owners(withKeep, false).inputs).toEqual(["S-3.1"])
  })

  it("flow2StepOps: bước đầu vào đang bị ẩn (skipped) ⇒ pending; đã chốt hoặc đang chờ giữ nguyên, bước giữ chốt không bao giờ mở", () => {
    const steps = [state("B-0.1", "skipped"), state("S-4.1", "skipped"), state("S-3.1", "accepted"), state("S-4.3", "skipped")]
    const ops = flow2StepOps({ steps, screens: [], functions: [] }, ["S-5.2"], [], "2026-11-08T00:00:00.000Z", ["S-4.1", "S-3.1"])
    const set = (path: string) => ops.find((o) => o.path === path)?.value
    expect(set("steps[id=S-4.1].status")).toBe("pending")
    expect(ops.some((o) => o.path.startsWith("steps[id=S-3.1]"))).toBe(false)
    expect(ops.some((o) => o.path.startsWith("steps[id=S-4.3]"))).toBe(false)
    const kept = flow2StepOps({ steps, screens: [], functions: [] }, ["S-5.2"], ["S-4.1"], "2026-11-08T00:00:00.000Z", ["S-4.1"])
    expect(kept.some((o) => o.path.startsWith("steps[id=S-4.1]") && o.path.endsWith(".status") && o.value === "pending")).toBe(false)
  })
})

describe("FLF-455 x FLF-460: bước của mục Ngoài phạm vi không được soạn", () => {
  const owner = templateSectionOwnerSteps("fixed:5.4", undefined)[0]
  const other = templateSectionOwnerSteps("fixed:5.5", undefined)[0]
  const sections = [
    { section_id: "fixed:5.4", title: "5.4 Other Requirements", status: "out_of_scope" as const, owner_steps: [] },
    { section_id: "fixed:2.1", title: "2.1 Actors", status: "missing" as const, owner_steps: ["S-3.1"] }
  ]

  it("bước sở hữu mục Ngoài phạm vi đang pending ⇒ skipped, bước soạn mục thiếu vẫn pending", () => {
    expect(owner).toBeTruthy()
    const skip = flow2SkipOwners(sections, undefined, { draft: ["S-3.1"], keep: [], inputs: [] })
    expect(skip).toContain(owner)
    const steps = [state(owner, "pending"), state("S-3.1", "pending")]
    const ops = flow2StepOps({ steps, screens: [], functions: [] }, ["S-3.1"], [], undefined, [], skip)
    expect(ops).toContainEqual({ op: "set", path: `steps[id=${owner}].status`, value: "skipped" })
  })

  it("bước cũng sở hữu mục cần soạn thì không bị bỏ qua", () => {
    const shared = [...sections, { section_id: "fixed:5.5", title: "5.5", status: "missing" as const, owner_steps: [owner, other] }]
    expect(flow2SkipOwners(shared, undefined, { draft: [owner], keep: [], inputs: [] })).not.toContain(owner)
  })
})
