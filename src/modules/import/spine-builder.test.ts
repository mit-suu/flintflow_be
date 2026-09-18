import { describe, expect, it } from "vitest"
import { applyRuleProfile, runDeterministicCheck } from "../spine/deterministic-check.js"
import { planTransaction } from "../spine/op-engine.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import { IdAllocator, collectEntities, fieldPath, flattenItem, normalizeKey, parseFieldPath, realSectionId, resolveProvisional } from "./extracted-entities.js"
import { findingOps } from "./check.service.js"
import { MODE1_RULE_PROFILE } from "./mode1-rule-profile.js"
import { buildImportOps } from "./spine-builder.js"

describe("extracted-entities", () => {
  it("chuẩn hoá khoá, cấp id không trùng", () => {
    expect(normalizeKey("uc01")).toBe("UC-01")
    expect(normalizeKey("NFR_P01")).toBe("NFR_P01")
    expect(normalizeKey(" BR 12 ")).toBe("BR-12")
    const alloc = new IdAllocator({ actors: ["A01"] })
    expect([alloc.next("actors"), alloc.next("actors"), alloc.next("nfrs")]).toEqual(["A02", "A03", "NFR-01"])
  })

  it("field phẳng ⇄ path, edited_value thắng value", () => {
    expect(fieldPath("project", null, "vision")).toBe("project.vision")
    expect(parseFieldPath("use_cases[id=UC-01].name")).toEqual({ entity: "use_cases", id: "UC-01", field: "name" })
    expect(parseFieldPath("bad path")).toBeNull()
    const fields = flattenItem({ entity: "actors", id: "A01", value: { name: "Learner", kind: "human", description: "" }, confidence: 0.9, field_confidence: { kind: 0.5 }, source_block_ids: ["B0003"], origin: "ai" })
    expect(fields.map((f) => [f.path, f.confidence])).toEqual([
      ["actors[id=A01].name", 0.9],
      ["actors[id=A01].kind", 0.5]
    ])
    fields[0].edited_value = "Student"
    const [entity] = collectEntities(fields).values()
    expect(entity.value).toEqual({ name: "Student", kind: "human" })
  })

  it("feature/function tạm ⇒ id theo số mục, function thuộc feature đứng trước", () => {
    const map = resolveProvisional([
      { block_id: "B0010", heading_text: "3.2 Authentication", section_id: "feature:@B0010", confidence: 0.85, detected_by: "style", confirmed: false },
      { block_id: "B0011", heading_text: "3.2.1 Register", section_id: "function:@B0011", confidence: 0.85, detected_by: "style", confirmed: false },
      { block_id: "B0020", heading_text: "Payments", section_id: "feature:@B0020", confidence: 0.7, detected_by: "style", confirmed: false },
      { block_id: "B0021", heading_text: "Pay", section_id: "function:@B0021", confidence: 0.7, detected_by: "style", confirmed: false }
    ])
    expect([...map.values()].map((p) => [p.id, p.feature_id])).toEqual([
      ["F-3.2", null],
      ["FR-3.2.1", "F-3.2"],
      ["F-01", null],
      ["FR-01", "F-01"]
    ])
    expect(realSectionId("function:@B0011", map)).toBe("function:FR-3.2.1")
    expect(realSectionId("fixed:2.1", map)).toBe("fixed:2.1")
  })
})

describe("buildImportOps", () => {
  it("dựng op hợp lệ với Spine rỗng: phân giải tên actor, feature General cho màn mồ côi, bỏ tham chiếu lạ", () => {
    const spine = createEmptySpine({ name: "Lumen" })
    const ops = buildImportOps(spine, [
      { entity: "project", id: null, value: { vision: "Learn online", goals: "1. Grow\n2. Retain" } },
      { entity: "actors", id: "A01", value: { name: "Learner", kind: "person" } },
      { entity: "use_cases", id: "UC-01", value: { name: "Register", actor_ids: ["learner", "Ghost"], includes: ["UC-99"] } },
      { entity: "screens", id: "SCR-01", value: { name: "Login" } },
      { entity: "functions", id: "FR-01", value: { name: "Log in", screen_id: "SCR-01", validations: [{ kind: "format", statement: "Email format" }, "Required password"] } },
      { entity: "nfrs", id: "NFR-01", value: { statement: "Respond in 2 s", category: "Performance" } },
      { entity: "permissions", id: "P001", value: { screen_id: "SCR-01", role_id: "R99", action: "view" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.project.goals).toEqual(["Grow", "Retain"])
    expect(plan.spine.actors[0].kind).toBe("human")
    expect(plan.spine.use_cases[0]).toMatchObject({ actor_ids: ["A01"], includes: [] })
    expect(plan.spine.features.map((f) => [f.name, f.order])).toEqual([["General", 0]])
    expect(plan.spine.screens[0]).toMatchObject({ feature_id: plan.spine.features[0].id, detail_status: "signed_off" })
    expect(plan.spine.functions[0]).toMatchObject({ screen_id: "SCR-01", feature_id: plan.spine.features[0].id, order: 0 })
    expect(plan.spine.functions[0].validations.map((v) => v.kind)).toEqual(["format", "business"])
    expect(plan.spine.nfrs[0]).toMatchObject({ category: "performance", kind: "quantitative" })
    expect(plan.spine.permissions).toEqual([])
  })
})

describe("hồ sơ luật mode 1 + cờ AI", () => {
  it("loại array_empty / non_english_content, hạ section_empty xuống vàng", () => {
    const spine = createEmptySpine({ name: "Lumen" })
    const all = runDeterministicCheck(spine)
    expect(all.some((c) => c.rule_id === "array_empty")).toBe(true)
    const mode1 = runDeterministicCheck(spine, [], { ruleProfile: MODE1_RULE_PROFILE })
    expect(mode1.some((c) => c.rule_id === "array_empty")).toBe(false)
    expect(mode1.filter((c) => c.rule_id === "section_empty").every((c) => c.level === "yellow")).toBe(true)
    expect(applyRuleProfile(all, undefined)).toBe(all)
  })

  it("finding AI ⇒ cờ vàng, section lạ ⇒ fixed:I, không lặp cờ đang mở", () => {
    const spine = createEmptySpine({ name: "Lumen" })
    const ops = findingOps(spine, [
      { rule: "ambiguity", section_id: "fixed:4.2.3", message: "vague", block_ids: ["B0001"] },
      { rule: "ambiguity", section_id: "feature:@B0009", message: "x", block_ids: [] },
      { rule: "ambiguity", section_id: "fixed:4.2.3", message: "vague", block_ids: [] }
    ], "import_semantic")
    expect(ops.map((o) => (o.value as { section_id: string; level: string; id: string }).section_id)).toEqual(["fixed:4.2.3", "fixed:I"])
    expect(ops.map((o) => (o.value as { id: string }).id)).toEqual(["FL001", "FL002"])
  })
})
