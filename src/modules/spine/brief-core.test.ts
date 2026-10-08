import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Addendum, Spine } from "./spine.types.js"
import { planTransaction } from "./op-engine.js"
import type { Op } from "./op.types.js"
import { briefCoreEntries, hasBriefCore, isBriefCoreTopic, isBriefPhase, isInBriefPhase, planBriefReextract, writesProjectVisionOrGoals } from "./brief-core.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const entry = (id: string, topic: string, content = "Nội dung", content_en = "Content"): Addendum => ({
  id,
  topic,
  content,
  content_en,
  target_section: "fixed:1",
  captured_at: "2026-09-30T00:00:00.000Z"
})

const withS11 = (status: "accepted" | "in_progress", addendum: Addendum[] = [entry("AD1", "vision"), entry("AD2", "goals"), entry("AD3", "goals")]): Spine => ({
  ...structuredClone(FIXTURE),
  addendum,
  steps: FIXTURE.steps.map((s) => (s.id === "S-1.1" ? { ...s, status } : s))
})

const run = (spine: Spine, ops: Op[]) => planTransaction(spine, { base_version: spine.spine_version, ops, by: "user-1" }, { startSeq: 1 })
const statusOfS11 = (spine: Spine) => spine.steps.find((s) => s.id === "S-1.1")?.status

describe("brief core helpers", () => {
  it("nhận topic lõi không phân biệt hoa thường/khoảng trắng", () => {
    expect(isBriefCoreTopic(" Vision ")).toBe(true)
    expect(isBriefCoreTopic("GOALS")).toBe(true)
    expect(isBriefCoreTopic("Why now")).toBe(false)
    expect(isBriefCoreTopic(undefined)).toBe(false)
  })

  it("briefCoreEntries: 1 vision + goals theo thứ tự mảng addendum, bỏ entry khác", () => {
    const spine = withS11("accepted", [entry("AD2", "goals"), entry("AD10", "goals"), entry("AD5", "Why now"), entry("AD1", "vision")])
    const core = briefCoreEntries(spine)
    expect(core.vision?.id).toBe("AD1")
    expect(core.goals.map((g) => g.id)).toEqual(["AD2", "AD10"])
    expect(hasBriefCore(spine)).toBe(true)
    expect(hasBriefCore(withS11("accepted", [entry("AD5", "Why now")]))).toBe(false)
  })

  it("isBriefPhase / isInBriefPhase", () => {
    expect(isBriefPhase("B-1")).toBe(true)
    expect(isBriefPhase("B-1.1")).toBe(true)
    expect(isBriefPhase("S-1")).toBe(false)
    expect(isBriefPhase(null)).toBe(false)
    const fresh = { progress: { ...FIXTURE.progress, current_phase: null }, steps: FIXTURE.steps.map((s) => ({ ...s, status: "pending" as const })) }
    expect(isInBriefPhase(fresh)).toBe(true)
    expect(isInBriefPhase({ ...fresh, steps: FIXTURE.steps.map((s) => ({ ...s, status: "accepted" as const })) })).toBe(false)
    expect(isInBriefPhase({ progress: { ...FIXTURE.progress, current_phase: "S-2" }, steps: fresh.steps })).toBe(false)
    expect(isInBriefPhase({ progress: { ...FIXTURE.progress, current_phase: "B-2" }, steps: fresh.steps })).toBe(true)
  })

  it("writesProjectVisionOrGoals: chỉ tính khi giá trị ĐỔI so với Spine hiện tại", () => {
    const spine = { project: { ...FIXTURE.project, vision: null, goals: [] } }
    const w = (op: "set" | "add" | "remove", path: string, value?: unknown) => writesProjectVisionOrGoals({ op, path, value }, spine)
    expect(w("set", "project.vision", "x")).toBe(true)
    expect(w("set", "project.vision", null)).toBe(false)
    expect(w("set", "project.goals", [])).toBe(false)
    expect(w("set", "project.goals", ["a"])).toBe(true)
    expect(w("add", "project.goals[]", "x")).toBe(true)
    expect(w("set", "project", { ...spine.project, stakes: "production" })).toBe(false)
    expect(w("set", "project", { ...spine.project, vision: "x" })).toBe(true)
    expect(w("set", "project", { ...spine.project, goals: ["x"] })).toBe(true)
    expect(w("set", "project", { form_factor: "web_app" })).toBe(false)
    expect(w("set", "project.form_factor", "web_app")).toBe(false)
  })
})

describe("planBriefReextract", () => {
  it("S-1.1 accepted + addendum đổi ⇒ một op đặt revision_requested", () => {
    const before = withS11("accepted")
    const after = { ...before, addendum: before.addendum.map((a) => (a.id === "AD2" ? { ...a, content_en: "Changed" } : a)) }
    expect(planBriefReextract(after, before)).toMatchObject([{ op: "set", path: "steps[id=S-1.1].status", value: "revision_requested" }])
  })

  it("S-1.1 chưa accepted hoặc addendum không đổi ⇒ không có op", () => {
    const before = withS11("in_progress")
    const after = { ...before, addendum: [...before.addendum, entry("AD4", "goals")] }
    expect(planBriefReextract(after, before)).toEqual([])
    const accepted = withS11("accepted")
    expect(planBriefReextract({ ...accepted }, accepted)).toEqual([])
  })
})

describe("op engine đánh dấu S-1.1 chờ duyệt lại", () => {
  it("lô sửa nội dung addendum khi S-1.1 accepted ⇒ change đặt steps[id=S-1.1].status", () => {
    const plan = run(withS11("accepted"), [{ op: "set", path: "addendum[id=AD2].content", value: "Mục tiêu đã sửa" }])
    expect(statusOfS11(plan.spine)).toBe("revision_requested")
    expect(plan.changes.map((c) => c.path)).toContain("steps[id=S-1.1].status")
  })

  it("thêm và bỏ entry addendum cũng đánh dấu", () => {
    const base = withS11("accepted")
    expect(statusOfS11(run(base, [{ op: "add", path: "addendum[]", value: entry("AD9", "goals") }]).spine)).toBe("revision_requested")
    expect(statusOfS11(run(base, [{ op: "remove", path: "addendum[id=AD3]" }]).spine)).toBe("revision_requested")
  })

  it("S-1.1 chưa accepted ⇒ không thêm op; lô không đụng addendum ⇒ giữ accepted", () => {
    const pending = run(withS11("in_progress"), [{ op: "set", path: "addendum[id=AD2].content", value: "x" }])
    expect(pending.changes.map((c) => c.path)).not.toContain("steps[id=S-1.1].status")
    const untouched = run(withS11("accepted"), [{ op: "set", path: "actors[id=A01].name", value: "Owner" }])
    expect(statusOfS11(untouched.spine)).toBe("accepted")
  })
})
