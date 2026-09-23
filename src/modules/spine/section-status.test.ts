import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Change, Spine } from "./spine.types.js"
import { buildProgressReport, computeSectionStates, computeStatus, progressByStep, readiness } from "./section-status.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const load = (file: string): Spine =>
  spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures", file), "utf8")))
const FIXTURE = load("spine-fixture-19-screens.json")
const LAST_SEQ = Math.max(...FIXTURE.steps.map((s) => s.last_seq ?? 0))

const change = (seq: number, p: string, step_id: string | null = null): Change => ({
  projectId: "p",
  seq,
  txn: "t",
  op: "set",
  path: p,
  before: "a",
  value: "b",
  reason: null,
  at: "2026-09-14T08:00:00.000Z",
  by: "u",
  step_id
})

describe("FLF-204 (BUG-26) — feature chỉ accepted khi function con cũng xong", () => {
  it("một function con còn draft ⇒ feature xuống draft", () => {
    const spine = structuredClone(FIXTURE)
    // Mở lại vòng của màn S01 (đang signed_off) ⇒ function của nó chưa chốt lại
    spine.steps = spine.steps.filter((s) => !s.id.endsWith("@S01"))
    expect(computeStatus(spine, [], "feature:F1")).toBe("draft")
  })

  it("function của màn đã chủ động để lại (placeholder) không kéo feature xuống", () => {
    expect(computeStatus(FIXTURE, [], "feature:F1"), "S02–S04 là placeholder, S01 đã signed_off").toBe("accepted")
  })
})

describe("computeSectionStates", () => {
  it("fixture không có change: derived / accepted / draft đúng", () => {
    const status = (id: string) => computeStatus(FIXTURE, [], id)
    expect(status("fixed:I")).toBe("derived")
    expect(status("fixed:5.5")).toBe("derived")
    expect(status("fixed:2.1")).toBe("accepted")
    expect(status("feature:F1")).toBe("accepted")
    expect(status("function:FN001")).toBe("accepted") // S01 signed_off, có S-5.x@S01
    expect(status("function:FN084")).toBe("accepted") // vòng @nonscreen
    expect(status("function:FN006")).toBe("draft") // S02 placeholder, không có step
    expect(computeSectionStates(FIXTURE, []).some((s) => s.status === "stale")).toBe(false)
  })

  it("Spine chưa step nào ⇒ mọi section không dẫn xuất là draft (tập rỗng không phải accepted)", () => {
    const minimal = load("spine-fixture-minimal.json")
    const states = computeSectionStates(minimal, [])
    expect(states.filter((s) => !s.derived).every((s) => s.status === "draft")).toBe(true)
  })

  it("đổi tên actor sau khi đã accepted ⇒ 2.1 và 2.2.2, 3.1.3, 2.2.1 stale; section khác giữ accepted", () => {
    const human = FIXTURE.actors.find((a) => a.kind === "human")!
    const states = new Map(computeSectionStates(FIXTURE, [change(LAST_SEQ + 1, `actors[id=${human.id}].name`)]).map((s) => [s.id, s.status]))
    for (const id of ["fixed:2.1", "fixed:2.2.2", "fixed:3.1.3", "fixed:2.2.1"]) expect(states.get(id), id).toBe("stale")
    expect(states.get("fixed:5.2")).toBe("accepted")
    expect(states.get("fixed:5.5")).toBe("derived")
  })

  it("change cũ hơn mốc accepted không làm stale; change của chính step sở hữu không làm stale section đó", () => {
    expect(computeStatus(FIXTURE, [change(1, "actors[id=A01].name")], "fixed:2.1")).toBe("accepted")
    const own = computeSectionStates(FIXTURE, [change(LAST_SEQ + 1, "actors[id=A01].name", "S-3.1")])
    expect(own.find((s) => s.id === "fixed:2.1")?.status).toBe("accepted")
    expect(own.find((s) => s.id === "fixed:2.2.2")?.status).toBe("stale")
  })

  it("FLF-198: step chốt mà không ghi gì (last_seq null) van co moc 'da xem toi day'", () => {
    const spine = structuredClone(FIXTURE)
    const owner = spine.steps.find((s) => s.id === "S-3.1")!
    owner.first_seq = null
    owner.last_seq = null

    // Chotist o seq LAST_SEQ+5; change nuoi section den TRUOC do ⇒ khong con la "moi hon"
    const accepted = { ...change(LAST_SEQ + 5, "steps[id=S-3.1].accepted_at"), value: "2026-09-23T05:00:00.000Z", step_id: "S-3.1" }
    const before = change(LAST_SEQ + 1, "actors[id=A01].kind", "S-4.1")
    expect(computeStatus(spine, [before, accepted], "fixed:2.1")).toBe("accepted")

    // Change sau moc chot thi van lam section cu
    const after = change(LAST_SEQ + 9, "actors[id=A01].kind", "S-4.1")
    expect(computeStatus(spine, [before, accepted, after], "fixed:2.1")).toBe("stale")
  })

  it("step sở hữu ở revision_requested ⇒ awaiting_reaccept và không còn accepted", () => {
    const spine = structuredClone(FIXTURE)
    spine.steps.find((s) => s.id === "S-3.1")!.status = "revision_requested"
    const state = computeSectionStates(spine, []).find((s) => s.id === "fixed:2.1")
    expect(state).toMatchObject({ status: "draft", awaiting_reaccept: true })
  })
})

describe("readiness / progressByStep", () => {
  it("điểm sẵn sàng không tính derived và section tuỳ chọn; red_open bỏ cờ đã waive/đóng", () => {
    const spine = structuredClone(FIXTURE)
    const flag = { level: "red" as const, section_id: "fixed:1", message: "", remediation_step: "S-2.1", opened_at_version: 1, target_id: null, waive_reason: null, waived_at_version: null }
    spine.flags = [
      { ...flag, id: "FL001", rule_id: "section_empty", resolved_at: null, waived_by_user: false },
      { ...flag, id: "FL002", rule_id: "diagram_stale", resolved_at: null, waived_by_user: true },
      { ...flag, id: "FL003", rule_id: "render_error", resolved_at: "2026-09-14T08:00:00.000Z", waived_by_user: false }
    ]
    const states = computeSectionStates(spine, [])
    const scored = states.filter((s) => s.required && !s.derived)
    const r = readiness(spine, [])
    expect(r.red_open).toBe(1)
    expect(r.stale).toBe(0)
    expect(r.accepted_pct).toBe(Math.round((scored.filter((s) => s.status === "accepted").length * 100) / scored.length))
    expect(r.accepted_pct).toBeLessThan(100) // function của màn placeholder còn draft
  })

  it("fixture: 68 step done / 51 + 5×6 = 81 — màn để lại (placeholder) không vào mẫu số", () => {
    // 19 màn: 5 signed_off + 14 placeholder. Đếm cả 14 màn để lại thì mẫu số là 151 và thanh tiến độ không bao giờ
    // chạm 100% được, trong khi `nextStep` vốn đã bỏ qua vòng của màn placeholder.
    expect(progressByStep(FIXTURE)).toEqual({ done: 68, total: 81, current_phase: "S-9", current_step: "S-9.5", show_percent: true })

    // màn được tả chi tiết trở lại ⇒ vòng của nó đếm như thường
    const detailed = { ...FIXTURE, screens: FIXTURE.screens.map((s) => ({ ...s, detail_status: "signed_off" as const })) }
    expect(progressByStep(detailed).total).toBe(151)
  })

  it("trước S-4.1 accepted ⇒ show_percent = false", () => {
    const minimal = load("spine-fixture-minimal.json")
    expect(progressByStep(minimal).show_percent).toBe(false)
    const report = buildProgressReport(minimal, [])
    expect(report.progress.show_percent).toBe(false)
    expect(report.sections.length).toBe(20)
  })
})
