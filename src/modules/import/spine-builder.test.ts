import { describe, expect, it } from "vitest"
import { applyRuleProfile, runDeterministicCheck } from "../spine/deterministic-check.js"
import { planTransaction } from "../spine/op-engine.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import { IdAllocator, collectEntities, fieldPath, findKnownId, flattenItem, nameKey, normalizeKey, parseFieldPath, realSectionId, resolveProvisional } from "./extracted-entities.js"
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

  it("FLF-251: ghép phần tử theo tên đã chuẩn hoá — bỏ số mục, dấu, hoa/thường, ký tự lạ", () => {
    expect(nameKey("3.6.2 Send Reminder")).toBe("send reminder")
    expect(nameKey("Log-In")).toBe(nameKey("log in"))
    expect(nameKey("Đăng nhập")).toBe("dang nhap")
    const known = [
      { entity: "functions", id: "FR-3.6.2", value: { name: "3.6.2 Send Paper Submission Deadline Reminder" }, confidence: 1, field_confidence: {}, source_block_ids: [], origin: "deterministic" as const },
      { entity: "glossary", id: "G01", value: { term: "SRS" }, confidence: 1, field_confidence: {}, source_block_ids: [], origin: "ai" as const }
    ]
    expect(findKnownId(known, "functions", "Send paper submission deadline reminder")).toBe("FR-3.6.2")
    expect(findKnownId(known, "glossary", "srs")).toBe("G01")
    expect(findKnownId(known, "actors", "SRS")).toBeNull()
    expect(findKnownId(known, "functions", "")).toBeNull()
  })
})

describe("buildImportOps", () => {
  it("dựng op hợp lệ với Spine rỗng: phân giải tên actor, feature General cho màn mồ côi, bỏ tham chiếu lạ", () => {
    const spine = createEmptySpine({ name: "Lumen" })
    const ops = buildImportOps(spine, [
      { entity: "project", id: null, value: { vision: "Learn online", goals: "1. Grow\n2. Retain", form_factor: "web_app" } },
      { entity: "actors", id: "A01", value: { name: "Learner", kind: "person" } },
      { entity: "use_cases", id: "UC-01", value: { name: "Register", actor_ids: ["learner", "Ghost"], includes: ["UC-99"] } },
      { entity: "screens", id: "SCR-01", value: { name: "Login" } },
      { entity: "functions", id: "FR-01", value: { name: "Log in", screen_id: "SCR-01", validations: [{ kind: "format", statement: "Email format" }, "Required password"] } },
      { entity: "nfrs", id: "NFR-01", value: { statement: "Respond in 2 s", category: "Performance" } },
      { entity: "permissions", id: "P001", value: { screen_id: "SCR-01", role_id: "R99", action: "view" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.project.goals).toEqual(["Grow", "Retain"])
    // Tài liệu ghi một nền tảng ⇒ mảng một phần tử (FLF-237)
    expect(plan.spine.project.form_factor).toEqual(["web_app"])
    expect(plan.spine.actors[0].kind).toBe("human")
    expect(plan.spine.use_cases[0]).toMatchObject({ actor_ids: ["A01"], includes: [] })
    expect(plan.spine.features.map((f) => [f.name, f.order])).toEqual([["General", 0]])
    expect(plan.spine.screens[0]).toMatchObject({ feature_id: plan.spine.features[0].id, detail_status: "signed_off" })
    expect(plan.spine.functions[0]).toMatchObject({ screen_id: "SCR-01", feature_id: plan.spine.features[0].id, order: 0 })
    expect(plan.spine.functions[0].validations.map((v) => v.kind)).toEqual(["format", "business"])
    expect(plan.spine.nfrs[0]).toMatchObject({ category: "performance", kind: "quantitative" })
    expect(plan.spine.permissions).toEqual([])
  })

  it("feature General không trùng id với feature trích được trong cùng lô (FLF-179)", () => {
    const spine = createEmptySpine({ name: "Lumen" })
    const ops = buildImportOps(spine, [
      { entity: "features", id: "F-01", value: { name: "Authentication" } },
      { entity: "features", id: "F-02", value: { name: "Courses" } },
      { entity: "screens", id: "SCR-01", value: { name: "Home" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.features.map((f) => [f.id, f.name])).toEqual([
      ["F-01", "Authentication"],
      ["F-02", "Courses"],
      ["F-03", "General"]
    ])
    expect(plan.spine.screens[0].feature_id).toBe("F-03")
  })

  it("FLF-251: tham chiếu theo tên chuẩn hoá (cột Feature có số mục), thông báo nối chức năng, thuật ngữ tiếng Việt", () => {
    const spine = createEmptySpine({ name: "Exam" })
    const ops = buildImportOps(spine, [
      { entity: "features", id: "F-3.2", value: { name: "Account Management" } },
      { entity: "screens", id: "SCR-01", value: { name: "Login", feature_id: "3.2 Account Management" } },
      { entity: "functions", id: "FR-3.2.1", value: { name: "Sign In", screen_id: "login", feature_id: "F-3.2" } },
      { entity: "actors", id: "A01", value: { name: "Exam Manager" } },
      { entity: "use_cases", id: "UC-01", value: { name: "Sign in", actor_ids: ["exam manager"], function_ids: ["sign in", "Ghost"] } },
      { entity: "messages", id: "MSG-01", value: { code: "AUTH-001", text: "Wrong password", function_ids: ["Sign In", "Nowhere"] } },
      { entity: "glossary", id: "G01", value: { term: "Absence", term_native: "Vắng thi", definition: "Not present" } },
      { entity: "glossary", id: "G02", value: { term: "Proctor", definition: "Exam supervisor" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.features.map((f) => f.name)).toEqual(["Account Management"])
    expect(plan.spine.screens[0].feature_id).toBe("F-3.2")
    expect(plan.spine.functions[0].screen_id).toBe("SCR-01")
    expect(plan.spine.use_cases[0]).toMatchObject({ actor_ids: ["A01"], function_ids: ["FR-3.2.1"] })
    expect(plan.spine.messages[0].function_ids).toEqual(["FR-3.2.1"])
    expect(plan.spine.glossary.map((g) => g.term_native)).toEqual(["Vắng thi", undefined])
  })
})

describe("hồ sơ luật mode 1 + cờ AI", () => {
  it("loại array_empty / non_english_content; section_empty giữ đỏ (D6, FLF-183)", () => {
    const spine = createEmptySpine({ name: "Lumen" })
    // FLF-213: Spine rỗng chưa chạy step nào, mode 2 chỉ soi mảng rỗng khi bước sinh ra mảng đã chốt —
    // so sánh với mode 1 phải ở lượt ký bản, nơi mọi cổng đều mở.
    const all = runDeterministicCheck(spine, [], { atBaseline: true })
    expect(all.some((c) => c.rule_id === "array_empty")).toBe(true)
    const mode1 = runDeterministicCheck(spine, [], { ruleProfile: MODE1_RULE_PROFILE })
    expect(mode1.some((c) => c.rule_id === "array_empty")).toBe(false)
    const empty = mode1.filter((c) => c.rule_id === "section_empty")
    expect(empty.length).toBeGreaterThan(0)
    expect(empty.every((c) => c.level === "red")).toBe(true)
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

describe("chunkBlocks (trần input mỗi lượt I-4)", () => {
  it("chia lô theo ngân sách, cắt block quá dài", async () => {
    const { chunkBlocks } = await import("./extract.service.js")
    const blocks = [{ text: "a".repeat(10) }, { text: "b".repeat(10) }, { text: "c".repeat(50) }, { text: "d" }]
    const batches = chunkBlocks(blocks, 25, 20)
    expect(batches.map((b) => b.map((x) => x.text.length))).toEqual([[10, 10], [33], [1]])
    expect(batches[1][0].text.endsWith("…(truncated)")).toBe(true)
    expect(chunkBlocks([], 25)).toEqual([])
  })
})
