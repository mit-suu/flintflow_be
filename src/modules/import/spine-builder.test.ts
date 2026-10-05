import { describe, expect, it } from "vitest"
import { applyRuleProfile, runDeterministicCheck } from "../spine/deterministic-check.js"
import { planTransaction } from "../spine/op-engine.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import {
  IdAllocator,
  aiItemId,
  collectEntities,
  compactKey,
  fieldPath,
  findKnownCompact,
  findKnownId,
  findKnownKey,
  flattenItem,
  idKey,
  nameKey,
  normalizeKey,
  parseFieldPath,
  realSectionId,
  resolveProvisional,
  type EntityItem
} from "./extracted-entities.js"
import { findingOps } from "./check.service.js"
import { MODE1_RULE_PROFILE } from "./mode1-rule-profile.js"
import { buildImportOps, droppedPermissionFindings, relationPhrase, type DroppedPermission } from "./spine-builder.js"

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

  it("FLF-252: mã so lỏng — 'A01' = 'A-01' = 'a1'; cấp id không trùng mã đã có khác dạng", () => {
    expect(idKey("A-01")).toBe(idKey("A01"))
    expect(idKey("a1")).toBe(idKey("A01"))
    expect(idKey("UC01")).toBe(idKey("UC-01"))
    expect(idKey("FR-3.02")).toBe(idKey("FR-3.2"))
    expect(idKey("E10")).not.toBe(idKey("E1"))
    expect(idKey("FR-3.2.1")).not.toBe(idKey("FR-32.1"))
    const alloc = new IdAllocator({ actors: ["A-01"] })
    expect(alloc.has("actors", "A01")).toBe(true)
    expect(alloc.next("actors")).toBe("A02")
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
    expect(aiItemId(known, "use_cases", "UC05", "Log in")).toBe("UC-05")
    expect(aiItemId(known, "use_cases", null, "log in")).toBe("UC-02")
    expect(aiItemId(known, "actors", null, "Guest", true)).toBeNull()
    expect(aiItemId(known, "actors", "A01", "Developer")).toBe(findKnownKey(known, "actors", "A-01"))
  })

  it("FLF-252: tên khác quy ước đặt tên — lớp ERD 'SubscriptionPlan' / 'PrAnalysis' = bảng 'subscription_plans' / 'pr_analyses'", () => {
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
        'Bảng phân quyền có "Sell Statistics" (quyền của Admin, Developer) nhưng phần mô tả màn hình không có màn này — quyền chưa vào dữ liệu; thêm màn hoặc sửa tên cho khớp qua change request'
      ],
      ["fixed:3.1.3", ["B0333"], 'Bảng phân quyền có vai trò "Auditor" không khớp vai trò / tác nhân nào — quyền trên Transaction List chưa vào dữ liệu; sửa tên cho khớp qua change request']
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

  it("FLF-252: khớp lỏng khi chỉ một phần tử khớp — tên màn có phần trong ngoặc / thiếu chữ Screen; mơ hồ ⇒ bỏ", () => {
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
