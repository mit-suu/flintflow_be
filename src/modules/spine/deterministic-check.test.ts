import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Change, Spine } from "./spine.types.js"
import { NON_WAIVABLE_RULES, RULES, runDeterministicCheck, type FlagCandidate } from "./deterministic-check.js"
import { buildIdIndex, sectionKeyExists } from "./reference-fields.js"
import { computeSourceHash } from "./source-hash.js"
import { createEmptySpine } from "./spine.repository.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const variant = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}
const red = (c: FlagCandidate[]) => c.filter((f) => f.level === "red")
const byRule = (c: FlagCandidate[], rule: string) => c.filter((f) => f.rule_id === rule)

describe("RULES", () => {
  it("10 luật đỏ + 6 luật vàng; 3 luật không waive được", () => {
    expect(RULES.filter((r) => r.level === "red")).toHaveLength(10)
    expect(RULES.filter((r) => r.level === "yellow")).toHaveLength(6)
    expect([...NON_WAIVABLE_RULES].sort()).toEqual(["array_empty", "dead_reference", "render_error"])
  })
})

describe("runDeterministicCheck", () => {
  it("fixture đầy đủ: 0 cờ đỏ (kể cả atBaseline), cờ vàng chỉ có thể là screen_no_function", () => {
    expect(red(runDeterministicCheck(FIXTURE))).toEqual([])
    expect(red(runDeterministicCheck(FIXTURE, [], { atBaseline: true }))).toEqual([])
    const yellowRules = new Set(runDeterministicCheck(FIXTURE).filter((f) => f.level === "yellow").map((f) => f.rule_id))
    for (const r of yellowRules) expect(["screen_no_function"]).toContain(r)
  })

  it("xoá actor thẳng tay ⇒ dead_reference ở §2.2.2, remediation S-3.2", () => {
    const flags = byRule(runDeterministicCheck(variant((s) => (s.actors = s.actors.filter((a) => a.id !== "A08")))), "dead_reference")
    expect(flags.map((f) => f.target_id).sort()).toEqual(["use_cases[id=UC01].actor_ids[=A08]", "use_cases[id=UC03].actor_ids[=A08]"])
    expect(flags.every((f) => f.section_id === "fixed:2.2.2" && f.remediation_step === "S-3.2")).toBe(true)
  })

  it("mảng bảo vệ rỗng ⇒ array_empty + section_empty", () => {
    const flags = runDeterministicCheck(variant((s) => (s.common_requirements = [])))
    expect(byRule(flags, "array_empty")).toMatchObject([{ section_id: "fixed:5.2", target_id: "common_requirements", remediation_step: "S-7.2" }])
    expect(byRule(flags, "section_empty")).toMatchObject([{ section_id: "fixed:5.2" }])
  })

  it("NFR reliability thiếu metric ⇒ nfr_missing_number", () => {
    const n = FIXTURE.nfrs.find((x) => x.category === "reliability")!
    const flags = byRule(runDeterministicCheck(variant((s) => delete s.nfrs.find((x) => x.id === n.id)!.metric)), "nfr_missing_number")
    expect(flags).toMatchObject([{ section_id: "fixed:4.2.2", target_id: n.id, remediation_step: "S-6.3" }])
  })

  it("render_error / diagram_stale (hash TBD bỏ qua, hash đúng không cờ)", () => {
    const d = FIXTURE.diagrams.find((x) => x.kind === "usecase")!
    const errored = runDeterministicCheck(variant((s) => Object.assign(s.diagrams.find((x) => x.id === d.id)!, { render_status: "error", error: "syntax" })))
    expect(byRule(errored, "render_error")).toMatchObject([{ section_id: "fixed:2.2.1", target_id: d.id, remediation_step: "S-3.6" }])

    const wrong = runDeterministicCheck(variant((s) => (s.diagrams.find((x) => x.id === d.id)!.source_hash = "0".repeat(64))))
    expect(byRule(wrong, "diagram_stale")).toMatchObject([{ target_id: d.id }])

    const fresh = variant((s) => (s.diagrams.find((x) => x.id === d.id)!.source_hash = computeSourceHash(FIXTURE, d)))
    expect(byRule(runDeterministicCheck(fresh), "diagram_stale")).toEqual([])
  })

  it("luật S-9 chỉ chạy khi atBaseline", () => {
    const spine = variant((s) => {
      s.screens.find((x) => x.id === "S02")!.detail_status = "pending"
      s.assumptions[0].status = "unconfirmed"
      s.steps.find((x) => x.id === "S-7.2")!.status = "revision_requested"
    })
    const changes: Change[] = [
      { projectId: "p", seq: 10_000, txn: "t", op: "set", path: "entities[id=E01].name", before: "a", value: "b", reason: null, at: "2026-09-14T08:00:00.000Z", by: "u", step_id: null }
    ]
    const normal = runDeterministicCheck(spine, changes)
    for (const rule of ["screen_pending_at_baseline", "unconfirmed_assumption", "section_stale_at_baseline", "section_awaiting_reaccept"]) {
      expect(byRule(normal, rule), rule).toEqual([])
    }

    const atBaseline = runDeterministicCheck(spine, changes, { atBaseline: true })
    expect(byRule(atBaseline, "screen_pending_at_baseline")).toMatchObject([{ target_id: "S02", section_id: "function:FN006", remediation_step: "S-5.1@S02" }])
    expect(byRule(atBaseline, "unconfirmed_assumption")).toMatchObject([
      { target_id: "AS01", section_id: "fixed:4.2.2", remediation_step: "S-6.3" }
    ])
    expect(byRule(atBaseline, "section_stale_at_baseline").map((f) => f.section_id)).toContain("fixed:3.1.5")
    expect(byRule(atBaseline, "section_awaiting_reaccept")).toMatchObject([{ section_id: "fixed:5.2", remediation_step: "S-7.2" }])
  })

  it("6 luật vàng cardinality + non_english_content (bỏ qua addendum)", () => {
    const flags = runDeterministicCheck(
      variant((s) => {
        s.roles[0].actor_id = null
        s.actors.push({ id: "A99", name: "Auditor", kind: "human", description: "" })
        s.use_cases[0].function_ids = []
        s.features.push({ id: "F7", name: "Empty", order: 6 })
        s.screens.push({ ...s.screens[1], id: "S99", flow_to: [], primary_function_id: null })
        s.actors[1].description = "Người dùng cuối"
      })
    )
    expect(byRule(flags, "role_no_actor")).toMatchObject([{ target_id: FIXTURE.roles[0].id }])
    expect(byRule(flags, "orphan_actor")).toMatchObject([{ target_id: "A99", remediation_step: "S-3.2" }])
    expect(byRule(flags, "usecase_no_function")).toMatchObject([{ target_id: FIXTURE.use_cases[0].id }])
    expect(byRule(flags, "empty_feature")).toMatchObject([{ section_id: "feature:F7" }])
    expect(byRule(flags, "screen_no_function")).toMatchObject([{ target_id: "S99" }])
    expect(byRule(flags, "non_english_content")).toMatchObject([{ target_id: FIXTURE.actors[1].id }])
    expect(flags.every((f) => f.level === "yellow" || f.rule_id === "dead_reference")).toBe(true)
  })

  it("Spine rỗng: mọi cờ đỏ có remediation_step và section_id phân giải được", () => {
    for (const spine of [createEmptySpine(), variant((s) => (s.screens = []))]) {
      const flags = runDeterministicCheck(spine, [], { atBaseline: true })
      expect(red(flags).length).toBeGreaterThan(0)
      const index = buildIdIndex(spine)
      for (const f of flags) {
        expect(f.remediation_step, f.rule_id).toMatch(/^(S|B)-\d/)
        expect(sectionKeyExists(index, f.section_id), `${f.rule_id} ${f.section_id}`).toBe(true)
      }
    }
  })
})
