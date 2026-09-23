/**
 * Check sau baseline v0 (nút 1.11–1.12) — phần hàm thuần (plan §8.2 `check.service.test.ts`). FLF-172 P4.
 * - Hồ sơ luật mode 1 (`mode1-rule-profile.ts`): luật loại trừ không bắn cờ, luật hạ mức ra vàng.
 * - AI semantic check chỉ ra cờ vàng.
 * Luồng thật (AI giả + recompute trên Mongo) ở `test/integration/mode1/check.service.int.test.ts`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { RULES, applyRuleProfile, runDeterministicCheck, type FlagCandidate } from "../spine/deterministic-check.js"
import { spineSchema } from "../spine/spine.schema.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Flag, Spine } from "../spine/spine.types.js"
import { countOpenFlags, findingOps, semanticProjection } from "./check.service.js"
import { IMPORT_SEMANTIC_RULE, MODE1_RULE_PROFILE } from "./mode1-rule-profile.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FULL: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const EXCLUDED = ["array_empty", "section_stale_at_baseline", "section_awaiting_reaccept", "screen_pending_at_baseline", "orphan_screen_at_baseline", "non_english_content", "usecase_no_function"]
// Mode 1 v2 (D6, FLF-183): section_empty giữ đỏ — mọi đầu mục mẫu FPT là cốt lõi
const DOWNGRADED = ["nfr_missing_number"]

const rulesOf = (c: FlagCandidate[]) => new Set(c.map((f) => f.rule_id))

describe("hồ sơ luật mode 1", () => {
  it("cấu hình một chỗ: 7 luật loại trừ, 1 luật hạ mức, đều là luật có thật", () => {
    expect([...MODE1_RULE_PROFILE.exclude].sort()).toEqual([...EXCLUDED].sort())
    expect([...MODE1_RULE_PROFILE.downgrade].sort()).toEqual([...DOWNGRADED].sort())
    const known = new Set(RULES.map((r) => r.rule_id))
    for (const r of [...EXCLUDED, ...DOWNGRADED]) expect(known.has(r), r).toBe(true)
    expect(Object.isFrozen(MODE1_RULE_PROFILE)).toBe(true)
  })

  it("mỗi luật: loại trừ ⇒ biến mất, hạ mức ⇒ vàng, còn lại giữ nguyên mức", () => {
    const candidates: FlagCandidate[] = RULES.map((r) => ({
      level: r.level,
      rule_id: r.rule_id,
      section_id: "fixed:1",
      target_id: null,
      message: r.rule_id,
      remediation_step: "S-1"
    }))
    const out = applyRuleProfile(candidates, MODE1_RULE_PROFILE)
    for (const r of RULES) {
      const hit = out.find((c) => c.rule_id === r.rule_id)
      if (EXCLUDED.includes(r.rule_id)) expect(hit, r.rule_id).toBeUndefined()
      else if (DOWNGRADED.includes(r.rule_id)) expect(hit?.level, r.rule_id).toBe("yellow")
      else expect(hit?.level, r.rule_id).toBe(r.level)
    }
    // giữ đỏ: dead_reference, render_error, diagram_stale, unconfirmed_assumption, section_empty (D6)
    expect(out.filter((c) => c.level === "red").map((c) => c.rule_id).sort()).toEqual(["dead_reference", "diagram_stale", "render_error", "section_empty", "unconfirmed_assumption"])
  })

  it("Spine rỗng (import chưa trích được gì): mode 1 chỉ còn cờ đỏ section_empty (đầu mục FPT thiếu — D6)", () => {
    const empty = createEmptySpine({ name: "Lumen" })
    const mode2 = runDeterministicCheck(empty, [], { atBaseline: true })
    expect(mode2.some((f) => f.rule_id === "array_empty" && f.level === "red")).toBe(true)
    const mode1 = runDeterministicCheck(empty, [], { atBaseline: true, ruleProfile: MODE1_RULE_PROFILE })
    expect(new Set(mode1.filter((f) => f.level === "red").map((f) => f.rule_id))).toEqual(new Set(["section_empty"]))
    expect(rulesOf(mode1).has("array_empty")).toBe(false)
    // thiếu số đo NFR vẫn chỉ báo vàng để vào gap report
    expect(mode1.some((f) => f.rule_id === "section_empty" && f.level === "red")).toBe(true)
    expect(mode1.some((f) => f.rule_id === "nfr_missing_number" && f.level === "yellow")).toBe(true)
  })

  it("Spine import thật: tiếng Việt, UC chưa gắn function, màn pending, mảng rỗng ⇒ không cờ loại trừ; dead reference vẫn đỏ", () => {
    const s = structuredClone(FULL)
    s.actors[0].description = "Người học đăng ký khoá học"
    s.use_cases[0].function_ids = []
    s.screens[0].detail_status = "pending"
    s.common_requirements = []
    const mode2 = rulesOf(runDeterministicCheck(s, [], { atBaseline: true }))
    for (const r of ["non_english_content", "usecase_no_function", "screen_pending_at_baseline", "array_empty"]) expect(mode2.has(r), r).toBe(true)

    const mode1 = runDeterministicCheck(s, [], { atBaseline: true, ruleProfile: MODE1_RULE_PROFILE })
    for (const r of EXCLUDED) expect(rulesOf(mode1).has(r), r).toBe(false)

    const broken = structuredClone(s)
    broken.use_cases[0].actor_ids = ["A99"]
    const dead = runDeterministicCheck(broken, [], { ruleProfile: MODE1_RULE_PROFILE }).filter((f) => f.rule_id === "dead_reference")
    expect(dead.length).toBeGreaterThan(0)
    expect(dead.every((f) => f.level === "red")).toBe(true)
  })
})

describe("findingOps — AI semantic check chỉ ra vàng", () => {
  const spine = (flags: Flag[] = []): Spine => ({ ...structuredClone(FULL), flags, spine_version: 7 })

  it("mọi finding ⇒ op thêm cờ vàng rule import_semantic, remediation C-1, id tiếp theo id lớn nhất", () => {
    const existing: Flag = {
      id: "FL009",
      level: "red",
      rule_id: "dead_reference",
      section_id: "fixed:1",
      target_id: null,
      message: "x",
      remediation_step: "S-1",
      opened_at_version: 1,
      resolved_at: null,
      waived_by_user: false,
      waive_reason: null,
      waived_at_version: null
    }
    // finding lạc thêm `level: "red"` (model tự bịa) cũng không làm cờ đỏ
    const findings = [
      { rule: "ambiguity", section_id: "fixed:4.2.3", message: "95% cần tải", block_ids: ["B0010"], level: "red" },
      { rule: "conflict", section_id: "fixed:5.1", message: "BR mâu thuẫn", block_ids: [] }
    ] as never
    const ops = findingOps(spine([existing]), findings, IMPORT_SEMANTIC_RULE)
    expect(ops).toHaveLength(2)
    for (const op of ops) {
      expect(op).toMatchObject({ op: "add", path: "flags[]" })
      expect((op as { value: Flag }).value).toMatchObject({ level: "yellow", rule_id: "import_semantic", remediation_step: "C-1", resolved_at: null, opened_at_version: 8 })
    }
    const flags = ops.map((o) => (o as { value: Flag }).value)
    expect(flags.map((f) => f.id)).toEqual(["FL010", "FL011"])
    expect(flags[0]).toMatchObject({ section_id: "fixed:4.2.3", target_id: "B0010", message: "[ambiguity] 95% cần tải" })
    expect(flags[1].target_id).toBeNull()
  })

  it("section model bịa ⇒ fixed:I; finding trùng cờ đang mở hoặc trùng nhau ⇒ bỏ", () => {
    const open = findingOps(spine(), [{ rule: "r", section_id: "fixed:4.2.3", message: "m", block_ids: [] }], IMPORT_SEMANTIC_RULE).map((o) => (o as { value: Flag }).value)
    const ops = findingOps(
      spine(open),
      [
        { rule: "r", section_id: "fixed:4.2.3", message: "m", block_ids: [] },
        { rule: "x", section_id: "fixed:99", message: "lạ", block_ids: [] },
        { rule: "x", section_id: "fixed:99", message: "lạ", block_ids: [] }
      ],
      IMPORT_SEMANTIC_RULE
    )
    expect(ops.map((o) => (o as { value: Flag }).value.section_id)).toEqual(["fixed:I"])
  })

  it("không finding ⇒ không op", () => {
    expect(findingOps(spine(), [], IMPORT_SEMANTIC_RULE)).toEqual([])
  })
})

describe("tiện ích check", () => {
  it("countOpenFlags chỉ đếm cờ chưa đóng", () => {
    const f = (level: "red" | "yellow", resolved_at: string | null) => ({ level, resolved_at }) as Flag
    expect(countOpenFlags([f("red", null), f("yellow", null), f("yellow", null), f("red", "2026-01-01T00:00:00.000Z")])).toEqual({ red: 1, yellow: 2 })
  })

  it("semanticProjection là phép chiếu gọn (chỉ vài mảng, cắt ở 12k ký tự)", () => {
    const proj = semanticProjection(FULL)
    expect(proj.length).toBeLessThanOrEqual(12_000 + "\n…(truncated)".length)
    const small = semanticProjection(createEmptySpine())
    expect(Object.keys(JSON.parse(small))).toEqual(["actors", "use_cases", "functions", "nfrs", "business_rules"])
  })
})
