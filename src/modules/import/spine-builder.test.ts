import { describe, expect, it } from "vitest"
import { applyRuleProfile, runDeterministicCheck } from "../spine/deterministic-check.js"
import { planTransaction } from "../spine/op-engine.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import {
  IdAllocator,
  aiItemId,
  canonicalFieldIds,
  collectEntities,
  compactKey,
  fieldPath,
  findKnownCompact,
  findKnownId,
  findKnownKey,
  flattenItem,
  idKey,
  imageOnlyGenericActors,
  nameKey,
  keepKey,
  normalizeKey,
  parseFieldPath,
  realSectionId,
  resolveProvisional,
  type EntityItem
} from "./extracted-entities.js"
import { findingOps } from "./check.service.js"
import { MODE1_RULE_PROFILE } from "./mode1-rule-profile.js"
import { buildImportOps, droppedPermissionFindings, relationPhrase, ruleTierOfSections, splitSubtitleComponents, type BuiltEntity, type DroppedPermission } from "./spine-builder.js"
import { buildLayoutSections } from "../render/layout-sections.js"

describe("extracted-entities", () => {
  it("chuẩn hoá khoá, cấp id không trùng", () => {
    expect(normalizeKey("uc01")).toBe("UC-01")
    expect(keepKey("  UC01 ")).toBe("UC01")
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

  it("FLF-251: ghép phần tử theo tên đã chuẩn hoá - bỏ số mục, dấu, hoa/thường, ký tự lạ", () => {
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

  it("FLF-252: mã so lỏng - 'A01' = 'A-01' = 'a1'; cấp id không trùng mã đã có khác dạng", () => {
    expect(idKey("A-01")).toBe(idKey("A01"))
    expect(idKey("a1")).toBe(idKey("A01"))
    expect(idKey("UC01")).toBe(idKey("UC-01"))
    expect(idKey("FR-3.02")).toBe(idKey("FR-3.2"))
    expect(idKey("E10")).not.toBe(idKey("E1"))
    expect(idKey("FR-3.2.1")).not.toBe(idKey("FR-32.1"))
    const alloc = new IdAllocator({ actors: ["A-01"] })
    expect(alloc.has("actors", "A01")).toBe(true)
    // FLF-361: id mới theo khuôn của tài liệu ("A-01" ⇒ "A-02"; "A01" ⇒ "A02")
    expect(alloc.next("actors")).toBe("A-02")
    expect(new IdAllocator({ actors: ["A01", "A07"] }).next("actors")).toBe("A08")
    expect(new IdAllocator({ use_cases: ["UC01", "UC02"] }).next("use_cases")).toBe("UC03")
    // id theo số mục không phải khuôn đánh số
    expect(new IdAllocator({ functions: ["FR-3.2.1"] }).next("functions")).toBe("FR-01")
  })

  it("FLF-252 aiItemId: khoá model chép từ known_keys khớp mã đã biết dù khác dạng; khoá là tên ⇒ như không có khoá", () => {
    const item = (entity: string, id: string, name: string): EntityItem => ({ entity, id, value: { name }, confidence: 1, field_confidence: {}, source_block_ids: [], origin: "deterministic" })
    const known = [item("actors", "A01", "Developer"), item("actors", "A02", "Admin"), item("entities", "E02", "repositories"), item("use_cases", "UC-02", "Log in")]
    // trước đây "A01" qua normalizeKey thành "A-01" ⇒ tác nhân thứ hai cùng tên
    expect(aiItemId(known, "actors", "A01", "Developer", true)).toBe("A01")
    expect(aiItemId(known, "actors", "a-2", "Admin")).toBe("A02")
    // model ghép "Repository" của ERD với "repositories" của bảng qua khoá ⇒ giữ
    expect(aiItemId(known, "entities", "E02", "Repository", true)).toBe("E02")
    // khoá chép lại tên ⇒ không phải mã: không khớp tên nào ⇒ null (cấp mới), khớp tên ⇒ id đã biết
    expect(aiItemId(known, "entities", "LimCallLog", "LimCallLog", true)).toBeNull()
    expect(aiItemId(known, "actors", "Admin", "Admin", true)).toBe("A02")
    // ảnh: khoá lạ model tự đặt thua tên trùng; chữ: mã tài liệu thắng
    expect(aiItemId(known, "actors", "ACT-9", "Developer", true)).toBe("A01")
    // FLF-361: mã tài liệu giữ đúng dạng ("UC05" không thành "UC-05")
    expect(aiItemId(known, "use_cases", "UC05", "Log in")).toBe("UC05")
    expect(aiItemId(known, "use_cases", null, "log in")).toBe("UC-02")
    expect(aiItemId(known, "actors", null, "Guest", true)).toBeNull()
    expect(aiItemId(known, "actors", "A01", "Developer")).toBe(findKnownKey(known, "actors", "A-01"))
  })

  it("FLF-252: tên khác quy ước đặt tên - lớp ERD 'SubscriptionPlan' / 'PrAnalysis' = bảng 'subscription_plans' / 'pr_analyses'", () => {
    expect(compactKey("SubscriptionPlan")).toBe(compactKey("subscription_plans"))
    expect(compactKey("PrAnalysis")).toBe(compactKey("pr_analyses"))
    expect(compactKey("Category")).toBe(compactKey("categories"))
    expect(compactKey("ChangedFile")).toBe(compactKey("changed_files"))
    expect(compactKey("Status")).toBe("status")
    expect(compactKey("Address")).toBe("address")
    const entity = (id: string, name: string): EntityItem => ({ entity: "entities", id, value: { name }, confidence: 1, field_confidence: {}, source_block_ids: [], origin: "deterministic" })
    const known = [entity("E12", "tenant_subscriptions"), entity("E13", "subscription_plans"), entity("E14", "subscription_usage")]
    expect(findKnownCompact(known, "entities", "SubscriptionPlan")).toBe("E13")
    // ERD không ghi mã, tên khác quy ước ⇒ thực thể của bảng, không thành thực thể thứ hai
    expect(aiItemId(known, "entities", null, "SubscriptionPlan", true)).toBe("E13")
    // nhiều phần tử cùng khoá ⇒ không đoán
    expect(findKnownCompact([...known, entity("E20", "SubscriptionPlans")], "entities", "subscription plan")).toBeNull()
  })
})

describe("FLF-361 giữ định dạng mã của tài liệu", () => {
  it("file có A01, UC01 ⇒ Spine giữ A01, UC01; tham chiếu UC-01 / A-01 trong chữ vẫn khớp; một phần tử ghi hai dạng ⇒ một cách viết", () => {
    const fields = canonicalFieldIds([
      { path: "actors[id=A01].name", value: "Lecturer" },
      { path: "use_cases[id=UC01].name", value: "Take attendance" },
      { path: "use_cases[id=UC-01].description", value: "Lecturer takes attendance." },
      { path: "use_cases[id=UC-01].actor_ids", value: ["A-01"] }
    ])
    expect(fields.map((f) => f.path)).toEqual(["actors[id=A01].name", "use_cases[id=UC01].name", "use_cases[id=UC01].description", "use_cases[id=UC01].actor_ids"])
    const entities = [...collectEntities(fields.map((f) => ({ ...f, confidence: 1, source_block_ids: [], origin: "deterministic" as const, confirmed: true })))].map(([, e]) => e)
    const spine = createEmptySpine({ name: "FAP" })
    const ops = buildImportOps(spine, entities)
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.actors.map((a) => a.id)).toEqual(["A01"])
    expect(plan.spine.use_cases.map((u) => [u.id, u.actor_ids])).toEqual([["UC01", ["A01"]]])
  })
})

describe("FLF-361 imageOnlyGenericActors - không sinh actor thừa từ ảnh", () => {
  const f = (path: string, value: unknown, origin: "ai" | "vision" | "deterministic", edited?: unknown) => ({ path, value, origin, ...(edited !== undefined ? { edited_value: edited } : {}) })
  it("actor cha \"User\" chỉ có trên sơ đồ, file có bảng actor ⇒ bỏ; actor cụ thể từ ảnh (Guest) vẫn giữ", () => {
    const fields = [
      f("actors[id=A01].name", "Lecturer", "deterministic"),
      f("actors[id=A02].name", "Student", "deterministic"),
      f("actors[id=A08].name", "User", "vision"),
      f("actors[id=A08].kind", "human", "vision"),
      f("actors[id=A09].name", "Guest", "vision")
    ]
    expect([...imageOnlyGenericActors(fields)]).toEqual(["actors|A08"])
  })
  it("file không liệt kê actor bằng chữ ⇒ giữ actor của ảnh; người dùng đã sửa ở wizard ⇒ giữ; actor User ghi trong bảng ⇒ giữ", () => {
    expect(imageOnlyGenericActors([f("actors[id=A08].name", "User", "vision")]).size).toBe(0)
    expect(imageOnlyGenericActors([f("actors[id=A01].name", "Lecturer", "ai"), f("actors[id=A08].name", "User", "vision", "User")]).size).toBe(0)
    expect(imageOnlyGenericActors([f("actors[id=A01].name", "User", "deterministic"), f("actors[id=A01].kind", "human", "vision")]).size).toBe(0)
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

  it("FLF-361: cấp business rule theo mục của file - rule ở 5.1 model đoán `high` vẫn là `detail` và in ở 5.1, không in ở mục 1", () => {
    expect(ruleTierOfSections(["fixed:5.1"])).toBe("detail")
    expect(ruleTierOfSections(["slot:high_rules"])).toBe("high")
    expect(ruleTierOfSections(["fixed:1", "fixed:5.1"])).toBe("detail")
    expect(ruleTierOfSections(["function:FR-01"])).toBeNull()
    const spine = createEmptySpine({ name: "FAP" })
    const ops = buildImportOps(spine, [
      { entity: "business_rules", id: "BR-01", value: { statement: "Lock account after 5 failed logins", tier: "high" }, sections: ["fixed:5.1"] },
      { entity: "business_rules", id: "BR-02", value: { statement: "Password at least 8 characters" }, sections: ["fixed:5.1"] },
      { entity: "business_rules", id: "BR-H1", value: { statement: "Only students of FPT use FAP", tier: "detail" }, sections: ["slot:high_rules"] },
      { entity: "business_rules", id: "BR-X", value: { statement: "Something", tier: "high" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.business_rules.map((r) => [r.id, r.tier])).toEqual([
      ["BR-01", "detail"],
      ["BR-02", "detail"],
      ["BR-H1", "high"],
      ["BR-X", "high"]
    ])
    // Bản render từ Spine (đoạn đã bị CR sửa / project chưa có đoạn): BR của 5.1 in ở 5.1
    const layout = [
      { section_id: "fixed:1", heading_text: "1 Overview", level: 1 },
      { section_id: "fixed:5.1", heading_text: "5.1 Business Rules", level: 2 }
    ]
    const sections = buildLayoutSections(plan.spine, { layout, language: "en" } as never, [], { diagramPng: () => undefined }).sections
    const text = (id: string) => JSON.stringify(sections.find((s) => s.id === id)?.blocks ?? [])
    expect(text("fixed:5.1")).toContain("Lock account after 5 failed logins")
    expect(text("fixed:1")).not.toContain("Lock account after 5 failed logins")
    expect(text("fixed:1")).toContain("Only students of FPT use FAP")
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

  it("FLF-252: cột Feature ghi tính năng mục 3 không có heading ⇒ tính năng theo đúng tên; ghi gọn / thêm hậu tố tên heading ⇒ heading đó; ô trống / mã lạ ⇒ General", () => {
    const spine = createEmptySpine({ name: "Smell" })
    const ops = buildImportOps(spine, [
      { entity: "features", id: "F-3.7", value: { name: "Reporting & Monitoring" } },
      { entity: "features", id: "F-3.10", value: { name: "User Management" } },
      { entity: "screens", id: "SCR-01", value: { name: "Dashboard", feature_id: "Dashboard" } },
      { entity: "screens", id: "SCR-02", value: { name: "Billing Overview", feature_id: "Billing & Subscription" } },
      { entity: "screens", id: "SCR-03", value: { name: "Usage History", feature_id: "Billing & Subscription" } },
      { entity: "screens", id: "SCR-04", value: { name: "Analysis Reports", feature_id: "Reporting" } },
      { entity: "screens", id: "SCR-05", value: { name: "User List", feature_id: "User Management (Admin)" } },
      { entity: "screens", id: "SCR-06", value: { name: "Home" } },
      { entity: "functions", id: "FR-01", value: { name: "Publish PR Comment", feature_id: "F-99" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    const featureName = (id: string) => plan.spine.features.find((f) => f.id === id)?.name
    expect(plan.spine.screens.map((s) => [s.name, featureName(s.feature_id)])).toEqual([
      ["Dashboard", "Dashboard"],
      ["Billing Overview", "Billing & Subscription"],
      ["Usage History", "Billing & Subscription"],
      ["Analysis Reports", "Reporting & Monitoring"],
      ["User List", "User Management"],
      ["Home", "General"]
    ])
    expect(featureName(plan.spine.functions[0].feature_id)).toBe("General")
    expect(plan.spine.features.map((f) => f.name)).toEqual(["Reporting & Monitoring", "User Management", "Dashboard", "Billing & Subscription", "General"])
  })

  it("FLF-252: quyền của ma trận không khớp màn / vai trò ⇒ không vào Spine nhưng được ghi lại để đặt cờ vàng (trước đây bỏ im lặng)", () => {
    const spine = createEmptySpine({ name: "Smell" })
    const dropped: DroppedPermission[] = []
    const ops = buildImportOps(
      spine,
      [
        { entity: "actors", id: "A02", value: { name: "Admin" } },
        { entity: "roles", id: "R02", value: { name: "Admin", actor_id: "Admin" } },
        { entity: "screens", id: "SCR-30", value: { name: "Transaction List" } },
        { entity: "permissions", id: "P001", value: { screen_id: "Transaction List", role_id: "Admin", action: "access" } },
        { entity: "permissions", id: "P002", value: { screen_id: "Sell Statistics", role_id: "Admin", action: "access" } },
        { entity: "permissions", id: "P003", value: { screen_id: "Transaction List", role_id: "Auditor", action: "access" } }
      ],
      dropped
    )
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.permissions.map((p) => [p.screen_id, p.role_id])).toEqual([["SCR-30", "R02"]])
    expect(dropped).toEqual([
      { screen: "Sell Statistics", role: "Admin", missing: "screen" },
      { screen: "Transaction List", role: "Auditor", missing: "role" }
    ])
    const findings = droppedPermissionFindings([...dropped, { screen: "Sell Statistics", role: "Developer", missing: "screen" }], ["B0333"])
    expect(findings.map((f) => [f.section_id, f.block_ids, f.message])).toEqual([
      [
        "fixed:3.1.3",
        ["B0333"],
        'Bảng phân quyền có "Sell Statistics" (quyền của Admin, Developer) nhưng phần mô tả màn hình không có màn này - quyền chưa vào dữ liệu; thêm màn hoặc sửa tên cho khớp qua change request'
      ],
      ["fixed:3.1.3", ["B0333"], 'Bảng phân quyền có vai trò "Auditor" không khớp vai trò / tác nhân nào - quyền trên Transaction List chưa vào dữ liệu; sửa tên cho khớp qua change request']
    ])
  })

  it("FLF-252: use case không ghi chức năng ⇒ nối chức năng trùng hẳn tên; đã ghi thì giữ; tên khác / hai chức năng cùng tên ⇒ không đoán", () => {
    const spine = createEmptySpine({ name: "Smell" })
    const ops = buildImportOps(spine, [
      { entity: "functions", id: "FR-3.2.1", value: { name: "Login with GitHub" } },
      { entity: "functions", id: "FR-3.5.3", value: { name: "Fix Code Smells" } },
      { entity: "functions", id: "FR-01", value: { name: "Export Report" } },
      { entity: "functions", id: "FR-02", value: { name: "Export Report" } },
      { entity: "use_cases", id: "UC-01", value: { name: "Login with github" } },
      { entity: "use_cases", id: "UC-02", value: { name: "Fix Recommendations" } },
      { entity: "use_cases", id: "UC-03", value: { name: "Export Report" } },
      { entity: "use_cases", id: "UC-04", value: { name: "Login with GitHub", function_ids: ["Fix Code Smells"] } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.use_cases.map((u) => [u.id, u.function_ids])).toEqual([
      ["UC-01", ["FR-3.2.1"]],
      ["UC-02", []],
      ["UC-03", []],
      ["UC-04", ["FR-3.5.3"]]
    ])
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

  it("FLF-252: tên hệ thống + phạm vi release tài liệu ghi vào project", () => {
    const spine = createEmptySpine({ name: "Lumen" })
    const ops = buildImportOps(spine, [
      { entity: "project", id: null, value: { system_name: "Lumen LMS", release_scope: { in: ["Course catalog", "Enrolment"], out: "Mobile app" } } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.project.system_name).toBe("Lumen LMS")
    expect(plan.spine.project.release_scope).toEqual({ in: ["Course catalog", "Enrolment"], out: ["Mobile app"] })
  })

  it("FLF-252: khớp lỏng khi chỉ một phần tử khớp - tên màn có phần trong ngoặc / thiếu chữ Screen; mơ hồ ⇒ bỏ", () => {
    const spine = createEmptySpine({ name: "Flint" })
    const ops = buildImportOps(spine, [
      { entity: "screens", id: "SCR-01", value: { name: "Landing Page" } },
      { entity: "screens", id: "SCR-02", value: { name: "Sign In Screen" } },
      { entity: "screens", id: "SCR-03", value: { name: "Report (Daily)" } },
      { entity: "screens", id: "SCR-04", value: { name: "Report (Weekly)" } },
      { entity: "roles", id: "R01", value: { name: "Guest" } },
      { entity: "permissions", id: "P001", value: { screen_id: "Landing Page (Dark)", role_id: "Guest", action: "access" } },
      { entity: "permissions", id: "P002", value: { screen_id: "Sign In", role_id: "guest", action: "access" } },
      { entity: "permissions", id: "P003", value: { screen_id: "Report", role_id: "Guest", action: "view" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.permissions.map((p) => [p.screen_id, p.role_id])).toEqual([
      ["SCR-01", "R01"],
      ["SCR-02", "R01"]
    ])
  })

  it("ma trận FPT: ô 'A / B' ⇒ quyền trên từng màn; dòng con không phải màn ⇒ thao tác trên màn cha", () => {
    const spine = createEmptySpine({ name: "TechMart" })
    const dropped: DroppedPermission[] = []
    const ops = buildImportOps(
      spine,
      [
        { entity: "screens", id: "SCR-01", value: { name: "Search Results" } },
        { entity: "screens", id: "SCR-02", value: { name: "Product Detail" } },
        { entity: "screens", id: "SCR-03", value: { name: "Order Queue" } },
        { entity: "screens", id: "SCR-04", value: { name: "Cancel Order" } },
        { entity: "roles", id: "R01", value: { name: "Guest" } },
        { entity: "roles", id: "R02", value: { name: "Sales Staff" } },
        { entity: "permissions", id: "P001", value: { screen_id: "Search Results / Product Detail", role_id: "Guest", action: "access" } },
        { entity: "permissions", id: "P002", value: { screen_id: "Order Queue", role_id: "Sales Staff", action: "access" } },
        { entity: "permissions", id: "P003", value: { screen_id: "Confirm / Reject Order", parent_screen: "Order Queue", role_id: "Sales Staff", action: "access" } },
        // Dòng con trùng tên một màn ⇒ vẫn là màn đó
        { entity: "permissions", id: "P004", value: { screen_id: "Cancel Order", parent_screen: "Order Queue", role_id: "Sales Staff", action: "access" } },
        // Một phần không khớp màn nào ⇒ không đoán, vẫn đặt cờ
        { entity: "permissions", id: "P005", value: { screen_id: "Search Results / Wishlist", role_id: "Guest", action: "access" } }
      ],
      dropped
    )
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.permissions.map((p) => [p.screen_id, p.role_id, p.action])).toEqual([
      ["SCR-01", "R01", "access"],
      ["SCR-02", "R01", "access"],
      ["SCR-03", "R02", "access"],
      ["SCR-03", "R02", "Confirm / Reject Order"],
      ["SCR-04", "R02", "access"]
    ])
    expect(new Set(plan.spine.permissions.map((p) => p.id)).size).toBe(5)
    expect(dropped).toEqual([{ screen: "Search Results / Wishlist", role: "Guest", missing: "screen" }])
  })

  it("FLF-252: quan hệ dạng 'động từ + Thực thể' (ERD FlintFlow xuất ra) ⇒ thực thể + nhãn quan hệ", () => {
    const pool = [
      { id: "E01", name: "Schedule Slot" },
      { id: "E02", name: "Slot" },
      { id: "E03", name: "Grade Record" }
    ]
    expect(relationPhrase("teaches Schedule Slot", pool)).toEqual({ id: "E01", verb: "teaches" })
    expect(relationPhrase("Grade Record", pool)).toEqual({ id: "E03", verb: "" })
    // động từ không phải tiếng Anh thường ⇒ chỉ giữ quan hệ, không giữ nhãn
    expect(relationPhrase("ghi nhận Grade Record", pool)).toEqual({ id: "E03", verb: "" })
    expect(relationPhrase("owns Invoice", pool)).toBeNull()

    const spine = createEmptySpine({ name: "Edu" })
    const ops = buildImportOps(spine, [
      { entity: "entities", id: "E01", value: { name: "User", relations: ["teaches Schedule Slot", "earns Grade Record", "Ghost"] } },
      { entity: "entities", id: "E02", value: { name: "Schedule Slot" } },
      { entity: "entities", id: "E03", value: { name: "Grade Record" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.entities[0]).toMatchObject({ relations: ["E02", "E03"], relation_verbs: { E02: "teaches", E03: "earns" } })
  })

  it("entity: thuộc tính (chuỗi hoặc object, bỏ trùng tên) và feature_ids phân giải theo tên / id feature", () => {
    const spine = createEmptySpine({ name: "Edu" })
    const ops = buildImportOps(spine, [
      { entity: "features", id: "F1", value: { name: "Enrolment" } },
      { entity: "entities", id: "E01", value: { name: "Student", attributes: ["student code", { name: "email", kind: "key", required: false, description: "Sign-in" }, { name: "Email" }, { name: "x", kind: "weird" }], feature_ids: ["Enrolment", "Ghost"] } },
      { entity: "entities", id: "E02", value: { name: "Course" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.entities[0].attributes).toEqual([
      { name: "student code", kind: "plain", required: true },
      { name: "email", kind: "key", required: false, description: "Sign-in" },
      { name: "x", kind: "plain", required: true }
    ])
    expect(plan.spine.entities[0].feature_ids).toEqual(["F1"])
    // tài liệu không ghi ⇒ rỗng (op engine điền [] cho mảng thiếu), không bịa
    expect(plan.spine.entities[1].attributes).toEqual([])
    expect(plan.spine.entities[1].feature_ids).toEqual([])
  })

  it("entity: vòng đời (states / transitions) - id <entity>-ST<n>, một initial, chuyển nối theo tên, bỏ chuyển hỏng", () => {
    const spine = createEmptySpine({ name: "Shop" })
    const ops = buildImportOps(spine, [
      {
        entity: "entities",
        id: "E01",
        value: {
          name: "Order",
          states: ["Pending", { name: "Paid" }, { name: "Shipped", final: true }, { name: "pending" }],
          transitions: [
            { from: "Pending", to: "Paid", event: "pay, now", guard: "payment cleared", action: "send receipt" },
            { from: "Paid", to: "Shipped", event: "ship" },
            { from: "Shipped", to: "Paid", event: "return" },
            { from: "Paid", to: "Ghost", event: "lose" },
            { from: "Pending", to: "Paid", event: "pay now" },
            { from: "Pending", to: "Paid" }
          ]
        }
      },
      { entity: "entities", id: "E02", value: { name: "Plain" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    const order = plan.spine.entities[0]
    expect(order.states).toEqual([
      { id: "E01-ST1", name: "Pending", initial: true },
      { id: "E01-ST2", name: "Paid" },
      { id: "E01-ST3", name: "Shipped", final: true }
    ])
    expect(order.transitions).toEqual([
      { from: "E01-ST1", to: "E01-ST2", event: "pay now", guard: "payment cleared", action: "send receipt" },
      { from: "E01-ST2", to: "E01-ST3", event: "ship" }
    ])
    // không ghi ⇒ rỗng, không bịa vòng đời
    expect(plan.spine.entities[1].states ?? []).toEqual([])
    expect(plan.spine.entities[1].transitions ?? []).toEqual([])
  })

  it("FLF-390: function đọc từ sơ đồ tuần tự - actor theo tên, `system`, bỏ message hỏng (hai đầu actor, lỗi thiếu guard)", () => {
    const spine = createEmptySpine({ name: "Shop" })
    const ops = buildImportOps(spine, [
      { entity: "actors", id: "A01", value: { name: "Customer", kind: "human" } },
      { entity: "features", id: "F1", value: { name: "Account" } },
      {
        entity: "functions",
        id: "FN001",
        value: {
          name: "Log in",
          feature_id: "F1",
          interactions: [
            { from: "Customer", to: "System", message: "Submit email, password", kind: "request", flow: "normal" },
            { from: "system", to: "Customer", message: "Show error", kind: "response", flow: "abnormal", guard: "wrong password" },
            { from: "system", to: "Customer", message: "Show lock notice", kind: "response", flow: "abnormal" },
            { from: "Customer", to: "Customer", message: "Think", kind: "request", flow: "normal" },
            { from: "system", to: "Customer", message: "Open home", kind: "response", flow: "normal" }
          ]
        }
      }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.functions[0].interactions).toEqual([
      { from: "A01", to: "system", message: "Submit email password", kind: "request", flow: "normal" },
      { from: "system", to: "A01", message: "Show error", kind: "response", flow: "abnormal", guard: "wrong password" },
      { from: "system", to: "A01", message: "Open home", kind: "response", flow: "normal" }
    ])
  })

  it("FLF-390: use case đọc từ sơ đồ activity - id nút <use case>-AN<n>, làn theo tên actor / system, flow theo id tạm, bỏ flow hỏng", () => {
    const spine = createEmptySpine({ name: "Shop" })
    const ops = buildImportOps(spine, [
      { entity: "actors", id: "A01", value: { name: "Customer", kind: "human" } },
      { entity: "features", id: "F1", value: { name: "Account" } },
      {
        entity: "use_cases",
        id: "UC01",
        value: {
          name: "Log in",
          actor_ids: ["Customer"],
          activity_nodes: [
            { id: "N1", kind: "initial" },
            { id: "N2", kind: "action", name: "Enter credentials", lane: "Customer" },
            { id: "N3", kind: "decision", name: "Valid?", lane: "System" },
            { id: "N4", kind: "action", name: "Open home", lane: "Ghost lane" },
            { id: "N5", kind: "Final" },
            { id: "N6", kind: "cloud", name: "unknown shape" }
          ],
          activity_flows: [
            { from: "N1", to: "N2" },
            { from: "N2", to: "N3" },
            { from: "N3", to: "N2", guard: "[invalid]" },
            { from: "N3", to: "N4", guard: "valid" },
            { from: "N4", to: "N5" },
            { from: "N4", to: "N4" },
            { from: "N4", to: "N9" }
          ]
        }
      }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    const fn = plan.spine.use_cases[0]
    expect(fn.activity_nodes).toEqual([
      { id: "UC01-AN1", kind: "initial" },
      { id: "UC01-AN2", kind: "action", name: "Enter credentials", lane: "A01" },
      { id: "UC01-AN3", kind: "decision", name: "Valid?", lane: "system" },
      { id: "UC01-AN4", kind: "action", name: "Open home" },
      { id: "UC01-AN5", kind: "final" }
    ])
    expect(fn.activity_flows).toEqual([
      { from: "UC01-AN1", to: "UC01-AN2" },
      { from: "UC01-AN2", to: "UC01-AN3" },
      { from: "UC01-AN3", to: "UC01-AN2", guard: "invalid" },
      { from: "UC01-AN3", to: "UC01-AN4", guard: "valid" },
      { from: "UC01-AN4", to: "UC01-AN5" }
    ])
  })

  it("FLF-390: sơ đồ triển khai đọc từ ảnh - cha theo tên (cha trước con), đường truyền thông trên nút, bỏ đường trùng / tự nối", () => {
    const spine = createEmptySpine({ name: "Shop" })
    const ops = buildImportOps(spine, [
      { entity: "deployment_nodes", id: "DN02", value: { name: "Node.js", kind: "execution_environment", parent: "App Server", components: ["API Service"], artifacts: ["api.js"], links: [{ to: "Database", protocol: "TCP" }] } },
      { entity: "deployment_nodes", id: "DN01", value: { name: "App Server", kind: "device", parent: null, links: [{ to: "Node.js" }, { to: "App Server" }] } },
      { entity: "deployment_nodes", id: "DN03", value: { name: "Database", kind: "weird", links: [{ to: "Node.js", protocol: "again" }] } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.deployment_nodes.map((n) => [n.id, n.kind, n.parent_id])).toEqual([
      ["DN01", "device", null],
      ["DN03", "node", null],
      ["DN02", "execution_environment", "DN01"]
    ])
    expect(plan.spine.deployment_nodes.find((n) => n.id === "DN02")).toMatchObject({ components: ["API Service"], artifacts: ["api.js"] })
    expect(plan.spine.deployment_links).toEqual([
      { from: "DN02", to: "DN03", protocol: "TCP" },
      { from: "DN01", to: "DN02" }
    ])
  })

  it("QLHS 11/11 bug #14: dòng chữ phụ dưới tên nút là mô tả, không phải component", () => {
    const spine = createEmptySpine({ name: "QLHS" })
    const ops = buildImportOps(spine, [
      { entity: "deployment_nodes", id: "DN01", value: { name: "Trình duyệt", components: ["GV", "phụ huynh"] } },
      { entity: "deployment_nodes", id: "DN02", value: { name: "Reverse proxy", components: ["TLS", "ép HTTPS"] } },
      { entity: "deployment_nodes", id: "DN03", value: { name: "Kho sao lưu", components: ["30 bản, tách biệt"] } },
      { entity: "deployment_nodes", id: "DN04", value: { name: "Máy chủ SMTP", description: ["của nhà trường"] } },
      { entity: "deployment_nodes", id: "DN05", value: { name: "CSDL quan hệ", description: "dữ liệu chính", components: ["dữ liệu chính"] } },
      { entity: "deployment_nodes", id: "DN06", value: { name: "Máy chủ ứng dụng", components: ["API Service", "Docker"] } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.deployment_nodes.map((n) => [n.id, n.description, n.components])).toEqual([
      ["DN01", "GV, phụ huynh", []],
      ["DN02", "TLS, ép HTTPS", []],
      ["DN03", "30 bản, tách biệt", []],
      ["DN04", "của nhà trường", []],
      ["DN05", "dữ liệu chính", []],
      ["DN06", undefined, ["API Service", "Docker"]]
    ])
  })

  it("splitSubtitleComponents: bảo thủ - tên phần mềm / tên đơn lẻ mơ hồ giữ là component", () => {
    const keep = (c: string[]) => expect(splitSubtitleComponents(c, "")).toEqual({ components: c, description: "" })
    keep(["Docker"])
    keep(["Web Browser"])
    keep(["nginx"])
    keep(["GV"])
    keep(["api.js", "chạy nền"])
    keep(["Notification Service", "gửi thư"])
    keep(["ApiGateway", "ép HTTPS"])
    keep(["phần mềm quản lý học sinh của nhà trường cấp hai"])
    expect(splitSubtitleComponents(["public", "port 443"], "")).toEqual({ components: [], description: "public, port 443" })
    expect(splitSubtitleComponents(["dữ liệu chính"], "")).toEqual({ components: [], description: "dữ liệu chính" })
    expect(splitSubtitleComponents(["Docker"], "API REST, Docker")).toEqual({ components: [], description: "API REST, Docker" })
    expect(splitSubtitleComponents(["Redis"], "API REST")).toEqual({ components: ["Redis"], description: "API REST" })
  })

  it("FLF-252: tham chiếu ghi mã khác dạng id ('E-02', 'a1') vẫn ra đúng phần tử", () => {
    const spine = createEmptySpine({ name: "Edu" })
    const ops = buildImportOps(spine, [
      { entity: "actors", id: "A01", value: { name: "Developer" } },
      { entity: "entities", id: "E01", value: { name: "user", relations: ["E-02"] } },
      { entity: "entities", id: "E02", value: { name: "repositories" } },
      { entity: "use_cases", id: "UC-01", value: { name: "Log in", actor_ids: ["a1"] } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.entities[0].relations).toEqual(["E02"])
    expect(plan.spine.use_cases[0].actor_ids).toEqual(["A01"])
  })

  it("FLF-252: quan hệ ERD ghi tên lớp ('PrAnalysis', 'Repository') ra thực thể bảng ghi tên bảng dữ liệu", () => {
    const spine = createEmptySpine({ name: "Smell" })
    const ops = buildImportOps(spine, [
      { entity: "entities", id: "E02", value: { name: "repositories" } },
      { entity: "entities", id: "E03", value: { name: "pull_requests", relations: ["Repository", "PrAnalysis"] } },
      { entity: "entities", id: "E04", value: { name: "pr_analyses" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.entities.find((e) => e.id === "E03")!.relations).toEqual(["E02", "E04"])
  })
})

describe("hồ sơ luật mode 1 + cờ AI", () => {
  it("loại array_empty / non_english_content / section_empty (mục FPT không bắt buộc ở mode 1)", () => {
    const spine = createEmptySpine({ name: "Lumen" })
    // FLF-213: Spine rỗng chưa chạy step nào, mode 2 chỉ soi mảng rỗng khi bước sinh ra mảng đã chốt —
    // so sánh với mode 1 phải ở lượt ký bản, nơi mọi cổng đều mở.
    const all = runDeterministicCheck(spine, [], { atBaseline: true })
    expect(all.some((c) => c.rule_id === "array_empty")).toBe(true)
    const mode1 = runDeterministicCheck(spine, [], { ruleProfile: MODE1_RULE_PROFILE })
    expect(mode1.some((c) => c.rule_id === "array_empty")).toBe(false)
    expect(mode1.some((c) => c.rule_id === "section_empty")).toBe(false)
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

describe("FLF-365 - trích tài liệu tham khảo / ma trận kiểm chứng (mẫu IEEE 29148)", () => {
  it("references + verifications vào Spine; mã yêu cầu như trong file phân giải ra id Spine, không ra thì giữ mã", () => {
    const spine = createEmptySpine({ name: "EduSchedule" })
    const ops = buildImportOps(spine, [
      { entity: "features", id: "F-01", value: { name: "Scheduling" } },
      { entity: "functions", id: "FR-01", value: { name: "Create timetable", feature_id: "F-01" } },
      { entity: "nfrs", id: "NFR-01", value: { statement: "p95 under 2 s", kind: "quantitative" } },
      { entity: "references", id: "REF-01", value: { title: "ISO/IEC/IEEE 29148:2018", version: "2018", kind: "normative" } },
      { entity: "references", id: "REF-02", value: { name: "Quy chế đào tạo", kind: "lạ" } },
      { entity: "verifications", id: "VER-01", value: { requirement_id: "FR-01", method: "test", artifact: "TC-01", status: "not run" } },
      { entity: "verifications", id: "VER-02", value: { requirement_id: "Create timetable", method: "demonstration" } },
      { entity: "verifications", id: "VER-03", value: { requirement_id: "FR-99", method: "guess" } },
      { entity: "verifications", id: "VER-04", value: { method: "test" } }
    ])
    const plan = planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 })
    expect(plan.spine.references).toEqual([
      { id: "REF-01", title: "ISO/IEC/IEEE 29148:2018", version: "2018", kind: "normative" },
      { id: "REF-02", title: "Quy chế đào tạo", kind: "informative" }
    ])
    expect(plan.spine.verifications.map((v) => [v.id, v.requirement_id, v.method])).toEqual([
      ["VER-01", "FR-01", "test"],
      ["VER-02", "FR-01", "demonstration"],
      ["VER-03", "FR-99", "other"]
    ])
    // FR-99 không có ⇒ cờ vàng verification_orphan
    expect(runDeterministicCheck(plan.spine).filter((f) => f.rule_id === "verification_orphan").map((f) => f.target_id)).toEqual(["VER-03"])
  })
})

describe("FLF-390 actor kế thừa, luồng ngữ cảnh, actor User cho use case đăng nhập dùng chung", () => {
  const actor = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ entity: "actors", id, value: { name, kind: "human", description: "", ...extra } })
  const techMart = () => [
    actor("A01", "Guest", { description: "A visitor who is not logged in.", flows_in: ["search keywords"], flows_out: ["product listings"] }),
    actor("A02", "Customer", { description: "A registered buyer. Inherits everything a Guest can do, and can manage the cart.", flows_in: ["orders, payments, returns"], flows_out: ["order status, invoices"] }),
    actor("A03", "Sales Staff"),
    actor("A04", "Warehouse Staff"),
    actor("A05", "Store Admin"),
    { entity: "actors", id: "A06", value: { name: "VNPay / MoMo", kind: "system", description: "", flows_in: ["payment result"], flows_out: ["payment / refund request"] } },
    { entity: "use_cases", id: "UC-02", value: { name: "Log In", actor_ids: ["Customer", "Sales Staff", "Warehouse Staff", "Store Admin"] } },
    { entity: "use_cases", id: "UC-03", value: { name: "Search Products", actor_ids: ["Guest", "Customer"] } }
  ]
  const apply = (entities: BuiltEntity[]) => {
    const spine = createEmptySpine({ name: "fpt" })
    const ops = buildImportOps(spine, entities)
    return planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 }).spine
  }

  it("mô tả \"Inherits everything a Guest can do\" ⇒ Customer.parent_id = Guest; flows_in/flows_out giữ đúng nhãn", () => {
    const spine = apply(techMart())
    const byName = new Map(spine.actors.map((a) => [a.name, a]))
    expect(byName.get("Customer")?.parent_id).toBe("A01")
    expect(byName.get("Customer")?.flows_in).toEqual(["orders, payments, returns"])
    expect(byName.get("Customer")?.flows_out).toEqual(["order status, invoices"])
    expect(byName.get("VNPay / MoMo")?.flows_out).toEqual(["payment / refund request"])
    expect(byName.get("Guest")?.parent_id ?? null).toBeNull()
  })

  it("parent_id ghi từ sơ đồ (tên) được phân giải; cha là actor system ⇒ bỏ", () => {
    const spine = apply([actor("A01", "Guest"), actor("A02", "Customer", { parent_id: "Guest" }), { entity: "actors", id: "A03", value: { name: "Bank", kind: "system" } }, actor("A04", "Clerk", { parent_id: "Bank" })])
    expect(spine.actors.find((a) => a.name === "Customer")?.parent_id).toBe("A01")
    expect(spine.actors.find((a) => a.name === "Clerk")?.parent_id ?? null).toBeNull()
  })

  it("FLF-375: Log In gắn ≥ 2 actor người chưa có cha ⇒ import GIỮ NGUYÊN trạng file (không thêm User); luật User áp lúc vẽ", () => {
    const spine = apply(techMart())
    expect(spine.actors.some((a) => a.name === "User")).toBe(false)
    expect(spine.use_cases.find((u) => u.name === "Log In")?.actor_ids).toEqual(["A02", "A03", "A04", "A05"])
    expect(spine.use_cases.find((u) => u.name === "Search Products")?.actor_ids).toEqual(["A01", "A02"])
  })
})

describe("relationRefs - chiều quan hệ trong ô 'Quan hệ' (QLHS 11/11)", () => {
  it("1–n ⇒ phía nhiều của thực thể này; n–1 ⇒ cha; mục không ghi bội số theo mục đứng trước", async () => {
    const { relationRefs } = await import("./spine-builder.js")
    expect(relationRefs(["1–n Điểm", "Điểm danh", "Hạnh kiểm"]).map((r) => [r.ref, r.side])).toEqual([["Điểm", "child"], ["Điểm danh", "child"], ["Hạnh kiểm", "child"]])
    expect(relationRefs(["n–1 Học sinh", "Môn học", "Học kỳ"]).map((r) => r.side)).toEqual(["parent", "parent", "parent"])
    expect(relationRefs(["1-1 Hồ sơ"])[0]).toEqual({ ref: "Hồ sơ", side: "one" })
    expect(relationRefs(["Học kỳ"])[0]).toEqual({ ref: "Học kỳ", side: "child" })
  })
})

describe("dropReciprocalRelations - mỗi cặp quan hệ một chiều (QLHS 11/11 bug #12)", () => {
  it("khoá ngoại quyết định chiều; không có thì thực thể đứng trước là cha; 1–1 giữ nguyên", async () => {
    const { dropReciprocalRelations } = await import("./spine-builder.js")
    const ent = (id: string, name: string, relations: string[], attributes: unknown[] = [], cardinality: Record<string, "1" | "N"> = {}) => ({ id, value: { name, attributes }, relations, cardinality })
    const list = [
      ent("E01", "Năm học", ["E02"]),
      ent("E02", "Học kỳ", ["E01", "E09"]),
      ent("E06", "Học sinh", ["E12"], [{ name: "mã" }, { name: "mã TK phụ huynh" }]),
      ent("E09", "Điểm", []),
      ent("E12", "Tài khoản", ["E06"]),
      ent("E20", "Hồ sơ", ["E21"], [], { E21: "1" }),
      ent("E21", "Ảnh", ["E20"])
    ]
    dropReciprocalRelations(list)
    const rel = Object.fromEntries(list.map((e) => [e.id, e.relations]))
    expect(rel.E01).toEqual(["E02"])
    expect(rel.E02).toEqual(["E09"])
    // Học sinh có "mã TK phụ huynh" ⇒ Tài khoản là cha dù Học sinh đứng trước
    expect(rel.E12).toEqual(["E06"])
    expect(rel.E06).toEqual([])
    expect(rel.E20).toEqual(["E21"])
    expect(rel.E21).toEqual(["E20"])
  })
})
