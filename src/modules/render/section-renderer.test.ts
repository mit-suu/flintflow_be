import { describe, expect, it } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import { buildRecordOfChanges, renderSection, sectionHeadingOf, type SectionRenderContext } from "./section-renderer.js"

const emptySpine = (): Spine => ({
  project: {
    name: "Demo",
    system_name: null,
    vision: null,
    goals: [],
    type: null,
    domain: null,
    complexity: null,
    form_factor: null,
    stakes: null,
    working_mode: null,
    review_mode: "balanced" as const,
    release_scope: { in: [], out: [] }
  },
  progress: { current_phase: null, current_step: null, screen_cursor: null, screen_queue: [], elicit_turns_this_phase: 0 },
  steps: [],
  features: [],
  actors: [],
  roles: [],
  use_cases: [],
  screens: [],
  permissions: [],
  entities: [],
  functions: [],
  nfrs: [],
  business_rules: [],
  common_requirements: [],
  messages: [],
  other_requirements: [],
  glossary: [],
  addendum: [],
  custom_sections: [],
  diagrams: [],
  assumptions: [],
  decisions: [],
  flags: [],
  sections: [],
  baselines: [],
  spine_version: 1
})

const spine = (): Spine => ({
  ...emptySpine(),
  project: {
    ...emptySpine().project,
    vision: "Turn a raw idea into an SRS.",
    goals: ["Ship a baseline-quality SRS in one day"],
    release_scope: { in: ["Guided pipeline"], out: ["PDF export"] }
  },
  features: [
    { id: "F1", name: "Authentication", order: 0 },
    { id: "F2", name: "Dashboard", order: 1 }
  ],
  actors: [
    { id: "A01", name: "Founder", kind: "human", description: "Owns the SRS." },
    { id: "A05", name: "Payment Gateway", kind: "system", description: "Processes payments." }
  ],
  roles: [{ id: "R1", name: "Registered User", actor_id: "A01" }],
  use_cases: [
    { id: "UC01", name: "Log In", actor_ids: ["A01"], function_ids: ["FN01"], description: "Authenticate.", includes: [], extends: [] },
    { id: "UC02", name: "Open Dashboard", actor_ids: ["A01"], function_ids: [], description: "Land on the dashboard.", includes: ["UC01"], extends: [] }
  ],
  screens: [
    {
      id: "S01",
      feature_id: "F1",
      name: "Login",
      description: "Entry screen.",
      flow_to: ["S02"],
      is_popup: false,
      tabs: [],
      primary_function_id: "FN01",
      queue_order: 1,
      detail_status: "signed_off"
    },
    {
      id: "S02",
      feature_id: "F2",
      name: "Dashboard",
      description: "Project list.",
      flow_to: [],
      is_popup: false,
      tabs: [],
      primary_function_id: null,
      queue_order: 2,
      detail_status: "signed_off"
    }
  ],
  permissions: [{ id: "P1", screen_id: "S01", role_id: "R1", action: "view" }],
  entities: [{ id: "E01", name: "User", description: "An account.", relations: ["E02"] }, { id: "E02", name: "Project", description: "A project.", relations: [] }],
  functions: [
    {
      id: "FN01",
      screen_id: "S01",
      feature_id: "F1",
      order: 0,
      name: "Submit Credentials",
      trigger: "User clicks Log in.",
      description: "Authenticates the user.",
      normal: ["Enter credentials.", "System verifies."],
      abnormal: ["Wrong password: show an error."],
      validations: [{ id: "FN01-V1", kind: "required", statement: "Password must not be empty." }],
      business_rule_ids: ["BR02"],
      priority: "must"
    },
    {
      id: "FN02",
      screen_id: null,
      feature_id: "F2",
      order: 0,
      name: "Nightly Aggregate",
      trigger: "Cron 00:00 UTC.",
      description: "Aggregates usage metrics.",
      normal: ["Scheduler fires.", "System writes aggregates."],
      abnormal: [],
      validations: [],
      business_rule_ids: [],
      priority: "should"
    }
  ],
  nfrs: [
    { id: "N01", category: "interface", statement: "HTTPS only.", kind: "descriptive", priority: "must" },
    { id: "N02", category: "usability", statement: "Onboarding under 15 min.", kind: "descriptive", priority: "should" },
    { id: "N03", category: "reliability", statement: "Uptime.", kind: "quantitative", metric: "availability", threshold: ">= 99.5%", priority: "must" }
  ],
  business_rules: [
    { id: "BR01", tier: "high", statement: "Every statement must be traceable.", source_validation_ids: [] },
    { id: "BR02", tier: "detail", statement: "Password must be hashed.", source_validation_ids: ["FN01-V1"] }
  ],
  common_requirements: [{ id: "CR01", category: "pagination", statement: "Lists paginate at 20." }],
  messages: [{ id: "MSG01", code: "E-AUTH-001", text: "Invalid credentials.", function_ids: ["FN01"] }],
  other_requirements: [{ id: "OR01", kind: "risk", statement: "Provider pricing may change." }],
  glossary: [{ id: "G01", term: "SRS", definition: "Software Requirement Specification." }],
  diagrams: [
    { id: "D01", kind: "context", section: "fixed:1", owner_kind: null, owner_id: null, puml: "@startuml\n@enduml", render_status: "ok", source_hash: "h1", rendered_at: "2026-09-01T00:00:00.000Z" },
    { id: "D02", kind: "usecase", section: "fixed:2.2.1", owner_kind: null, owner_id: null, puml: "@startuml\n@enduml", render_status: "ok", source_hash: "h2", rendered_at: "2026-09-01T00:00:00.000Z" },
    { id: "D03", kind: "screen_flow", section: "fixed:3.1.1", owner_kind: null, owner_id: null, puml: "@startuml\n@enduml", render_status: "ok", source_hash: "h3", rendered_at: "2026-09-01T00:00:00.000Z" },
    { id: "D04", kind: "erd", section: "fixed:3.1.5", owner_kind: null, owner_id: null, puml: "@startuml\n@enduml", render_status: "ok", source_hash: "h4", rendered_at: "2026-09-01T00:00:00.000Z" },
    { id: "D05", kind: "screen_layout", section: "function:FN01", owner_kind: "screen", owner_id: "S01", puml: "@startuml\n@enduml", render_status: "ok", source_hash: "h5", rendered_at: "2026-09-01T00:00:00.000Z" }
  ]
})

const PNG_BY_ID: Record<string, string> = { D01: "png-d01", D02: "png-d02", D03: "png-d03", D04: "png-d04", D05: "png-d05" }

const ctx = (overrides: Partial<SectionRenderContext> = {}): SectionRenderContext => ({
  number: "0",
  diagramPng: (id) => PNG_BY_ID[id],
  numberOf: (id) => (id === "feature:F1" ? "3.2" : id === "feature:F2" ? "3.3" : undefined),
  ...overrides
})

describe("renderSection — fixed sections", () => {
  it("fixed:1 — vision, goals, release scope, high business rules, external systems, context diagram", () => {
    const section = renderSection(spine(), "fixed:1", ctx({ number: "1" }))
    expect(section).toMatchSnapshot()
    expect(section.heading).toBe("Product Overview")
    expect(section.level).toBe(1)
    expect(section.blocks[0]).toEqual({ type: "paragraph", runs: [{ text: "Turn a raw idea into an SRS." }] })
    expect(section.blocks.some((b) => b.type === "image" && b.png === "png-d01")).toBe(true)
    // BR01 (tier high) rendered here, BR02 (tier detail) must NOT be
    const text = JSON.stringify(section.blocks)
    expect(text).toContain("Every statement must be traceable")
    expect(text).not.toContain("Password must be hashed")
    expect(text).toContain("Payment Gateway")
  })

  it("fixed:2.1 — actors table (mọi actor, mọi kind)", () => {
    const section = renderSection(spine(), "fixed:2.1", ctx({ number: "2.1" }))
    const table = section.blocks[0]
    expect(table).toMatchObject({ type: "table", header: [[{ text: "ID" }], [{ text: "Name" }], [{ text: "Kind" }], [{ text: "Description" }]] })
    expect(table.type === "table" && table.rows).toHaveLength(2)
  })

  it("fixed:2.2.1 — use case diagram image only", () => {
    const section = renderSection(spine(), "fixed:2.2.1", ctx({ number: "2.2.1" }))
    expect(section.blocks).toEqual([{ type: "image", png: "png-d02", caption: "Use Case Diagram" }])
  })

  it("fixed:3.1.1 — chỉ ảnh sơ đồ, chú thích 'Screens flow for <actor>' lấy từ title của từng hình", () => {
    const s = spine()
    const base = s.diagrams.find((d) => d.id === "D03")!
    s.diagrams = [
      ...s.diagrams.filter((d) => d.id !== "D03"),
      { ...base, id: "D03-1", puml: '@startdot\ndigraph screens_flow {\n  label="Screens flow for Founder";\n}\n@enddot' },
      { ...base, id: "D03-2", puml: '@startdot\ndigraph screens_flow {\n  label="Screens flow for Guest";\n}\n@enddot' }
    ]
    const section = renderSection(s, "fixed:3.1.1", ctx({ number: "3.1.1", diagramPng: (id) => `png-${id}` }))
    expect(section.blocks).toEqual([
      { type: "image", png: "png-D03-1", caption: "Screens flow for Founder" },
      { type: "image", png: "png-D03-2", caption: "Screens flow for Guest" }
    ])
    // Hình không có title (sơ đồ chung trước khi tách actor) giữ chú thích cũ
    expect(renderSection(spine(), "fixed:3.1.1", ctx()).blocks).toEqual([{ type: "image", png: "png-d03", caption: "Screens Flow Diagram" }])
  })

  it("fixed:2.2.2 — bảng 6 cột, in tên actor và tên use case", () => {
    const section = renderSection(spine(), "fixed:2.2.2", ctx({ number: "2.2.2" }))
    const table = section.blocks[0]
    expect(table).toMatchObject({ type: "table" })
    expect(table.type === "table" && table.header.flat().map((r) => r.text)).toEqual(["ID", "Use Case", "Actors", "Use Case Description", "Includes", "Extends"])
    expect(table.type === "table" && table.rows[0]).toEqual([[{ text: "UC01" }], [{ text: "Log In" }], [{ text: "Founder" }], [{ text: "Authenticate." }], [{ text: "" }], [{ text: "" }]])
    // Cột quan hệ in TÊN use case, không phải id thô
    expect(table.type === "table" && table.rows[1][4]).toEqual([{ text: "Log In" }])
    expect(table.type === "table" && table.rows[1][5]).toEqual([{ text: "" }])
  })

  it("fixed:3.1.2 — bảng Feature | Screen dùng số hiệu feature tính lúc assemble (numberOf)", () => {
    const section = renderSection(spine(), "fixed:3.1.2", ctx({ number: "3.1.2" }))
    const table = section.blocks[0]
    expect(table.type === "table" && table.rows[0][0]).toEqual([{ text: "3.2 Authentication" }])
    expect(table.type === "table" && table.rows[1][0]).toEqual([{ text: "3.3 Dashboard" }])
  })

  it("fixed:3.1.3 — ma trận màn × vai trò (T15 review T9: cột = role, hàng = screen, ô = action gộp)", () => {
    const section = renderSection(spine(), "fixed:3.1.3", ctx({ number: "3.1.3" }))
    expect(section.blocks).toEqual([
      {
        type: "table",
        header: [[{ text: "Screen" }], [{ text: "Registered User" }]],
        rows: [
          [[{ text: "Login" }], [{ text: "view" }]],
          [[{ text: "Dashboard" }], [{ text: "—" }]]
        ]
      }
    ])
  })

  it("fixed:3.1.4 — chỉ function non-screen", () => {
    const section = renderSection(spine(), "fixed:3.1.4", ctx({ number: "3.1.4" }))
    const table = section.blocks[0]
    expect(table.type === "table" && table.rows).toHaveLength(1)
    expect(table.type === "table" && table.rows[0][0]).toEqual([{ text: "Nightly Aggregate" }])
  })

  it("fixed:3.1.5 — erd image + bảng entity", () => {
    const section = renderSection(spine(), "fixed:3.1.5", ctx({ number: "3.1.5" }))
    expect(section.blocks[0]).toEqual({ type: "image", png: "png-d04", caption: "Entity Relationship Diagram" })
    expect(section.blocks[1]).toMatchObject({ type: "table" })
  })

  it("fixed:4.2.2 — bảng nfr có metric/threshold", () => {
    const section = renderSection(spine(), "fixed:4.2.2", ctx({ number: "4.2.2" }))
    expect(section.blocks).toEqual([
      {
        type: "table",
        header: [[{ text: "Statement" }], [{ text: "Metric" }], [{ text: "Threshold" }], [{ text: "Priority" }]],
        rows: [[[{ text: "Uptime." }], [{ text: "availability" }], [{ text: ">= 99.5%" }], [{ text: "must" }]]]
      }
    ])
  })

  it("fixed:5.1 — chỉ business_rules tier=detail", () => {
    const section = renderSection(spine(), "fixed:5.1", ctx({ number: "5.1" }))
    expect(section.blocks).toEqual([{ type: "bullet_list", items: [[{ text: "Password must be hashed." }]] }])
  })

  it("fixed:5.5 — glossary luôn render (derived)", () => {
    const section = renderSection(spine(), "fixed:5.5", ctx({ number: "5.5", status: "derived" }))
    expect(section.status).toBe("derived")
    expect(section.blocks[0]).toMatchObject({ type: "table" })
  })

  it("section rỗng trả blocks: [] (partial ở assemble.service dựa vào đây)", () => {
    const empty = renderSection(emptySpine(), "fixed:5.4", ctx({ number: "5.4" }))
    expect(empty.blocks).toEqual([])
  })
})

describe("renderSection — feature/function", () => {
  it("feature:<id> — liệt kê screens của feature, heading = tên feature", () => {
    const section = renderSection(spine(), "feature:F1", ctx({ number: "3.2" }))
    expect(section.heading).toBe("Authentication")
    expect(section.level).toBe(2)
    expect(section.blocks).toEqual([{ type: "paragraph", runs: [{ text: "Screens: Login" }] }])
  })

  it("function:<id> — trigger/description/normal/abnormal/validations/business rules + ảnh screen_layout khi là primary_function_id", () => {
    const section = renderSection(spine(), "function:FN01", ctx({ number: "3.2.1" }))
    expect(section.heading).toBe("Submit Credentials")
    expect(section.level).toBe(3)
    const text = JSON.stringify(section.blocks)
    expect(text).toContain("User clicks Log in.")
    expect(text).toContain("Wrong password")
    expect(text).toContain("Password must not be empty")
    expect(text).toContain("Password must be hashed.") // business rule BR02 referenced by FN01
    expect(section.blocks.some((b) => b.type === "image" && b.png === "png-d05")).toBe(true)
  })

  it("function:<id> không bật functionLayout (mode 1 import) ⇒ giữ khung cũ Trigger · Description · Normal Flow", () => {
    const blocks = renderSection(spine(), "function:FN01", ctx({ number: "3.2.1" })).blocks
    expect(blocks[0]).toEqual({ type: "paragraph", runs: [{ text: "Trigger: ", bold: true }, { text: "User clicks Log in." }] })
    expect(blocks).toContainEqual({ type: "heading", level: 4, text: "Normal Flow" })
    expect(JSON.stringify(blocks)).not.toContain("Function trigger")
  })

  it("function:<id> — mẫu FPT: 4 nhóm heading 4, mục con là danh sách gạch đầu dòng, mục trống ghi N/A", () => {
    const item = (label: string, text?: string) => (text === undefined ? [{ text: `${label}: `, bold: true }] : [{ text: `${label}: `, bold: true }, { text }])
    const bullets = (...items: ReturnType<typeof item>[]) => ({ type: "bullet_list", items })
    const h = (text: string) => ({ type: "heading", level: 4, text })
    const onScreen = renderSection(spine(), "function:FN01", ctx({ number: "3.2.1", functionLayout: "fpt" })).blocks
    expect(onScreen).toEqual([
      h("Function trigger"),
      bullets(item("Navigation path", "Login"), item("Timing frequency", "User clicks Log in.")),
      h("Function description"),
      bullets(
        item("Actors / Roles", "Founder"),
        item("Purpose", "Authenticates the user."),
        // Hình D05 không phải wireframe salt ⇒ Interface dùng mô tả màn
        item("Interface", "Login screen: Entry screen."),
        item("Data processing", "System verifies.")
      ),
      h("Screen layout"),
      { type: "image", png: "png-d05", caption: "Screen Layout — Login" },
      h("Function details"),
      bullets(
        item("Data", "User"),
        item("Validation", "Password must not be empty."),
        item("Business rules", "Password must be hashed."),
        item("Normal case")
      ),
      { type: "numbered_list", items: [[{ text: "Enter credentials." }], [{ text: "System verifies." }]] },
      bullets(item("Abnormal case", "Wrong password: show an error."))
    ])

    // Function không thuộc màn, không use case: đủ khung, mục không có dữ liệu ghi N/A
    const nonScreen = renderSection(spine(), "function:FN02", ctx({ number: "3.3.1", functionLayout: "fpt" })).blocks
    const items = nonScreen.flatMap((b) => (b.type === "bullet_list" ? b.items : []))
    const value = (label: string) => items.find((i) => i[0].text === `${label}: `)?.[1]?.text
    expect([value("Navigation path"), value("Actors / Roles"), value("Interface"), value("Validation"), value("Abnormal case")]).toEqual(["N/A", "N/A", "N/A", "N/A", "N/A"])
    expect(nonScreen[nonScreen.findIndex((b) => b.type === "heading" && b.text === "Screen layout") + 1]).toEqual({ type: "paragraph", runs: [{ text: "N/A" }] })
  })

  it("feature:<id> — mẫu FPT chỉ có tiêu đề, không nội dung; mode 1 giữ dòng liệt kê màn", () => {
    expect(renderSection(spine(), "feature:F1", ctx({ number: "3.2", functionLayout: "fpt" })).blocks).toEqual([])
    expect(renderSection(spine(), "feature:F1", ctx({ number: "3.2" })).blocks).not.toEqual([])
  })

  it("function:<id> — mẫu FPT: Navigation path theo Screens Flow, Actors chỉ actor người, Interface đọc từ wireframe", () => {
    const s = spine()
    s.actors.push({ id: "A02", name: "Buyer", kind: "human", description: "" })
    s.roles.push({ id: "R2", name: "Buyer role", actor_id: "A02" }, { id: "R3", name: "Gateway role", actor_id: "A05" })
    s.permissions.push({ id: "P2", screen_id: "S03", role_id: "R2", action: "view" }, { id: "P3", screen_id: "S03", role_id: "R3", action: "view" })
    s.screens.push({ id: "S03", feature_id: "F2", name: "Settings", description: "", flow_to: [], is_popup: true, tabs: [], primary_function_id: "FN03", queue_order: 3, detail_status: "signed_off" })
    s.screens[1].flow_to = ["S03"]
    s.diagrams.push({
      id: "D06",
      kind: "screen_layout",
      section: "function:FN03",
      owner_kind: "screen",
      owner_id: "S03",
      puml: ["@startsalt", "{^\"Settings\"", "  Project name", "  \"Sunrise Villa        \"", "  [ ] Archived", "  { [ Cancel ] | [   Save   ] }", "}", "@endsalt", ""].join("\n"),
      render_status: "ok",
      source_hash: "h6",
      rendered_at: "2026-09-01T00:00:00.000Z"
    })
    s.functions.push({
      id: "FN03",
      screen_id: "S03",
      feature_id: "F2",
      order: 0,
      name: "Rename Project",
      trigger: "User clicks Save.",
      description: "Renames a project.",
      normal: ["User types a name.", "The system stores the new name."],
      abnormal: [],
      validations: [{ id: "FN03-V1", kind: "business", statement: "Password must be hashed." }],
      business_rule_ids: ["BR02"],
      priority: null
    })
    const items = renderSection(s, "function:FN03", ctx({ number: "3.3.2", functionLayout: "fpt" })).blocks.flatMap((b) => (b.type === "bullet_list" ? b.items : []))
    const value = (label: string) => items.find((i) => i[0].text === `${label}: `)?.[1]?.text
    expect(value("Navigation path")).toBe("Login > Dashboard > Settings")
    // Không use case nào chứa FN03 ⇒ actor người của vai trò có quyền trên màn; actor system (Payment Gateway) bị bỏ
    expect(value("Actors / Roles")).toBe("Buyer")
    expect(value("Interface")).toBe("Settings pop-up: Project name input, Archived checkbox, Cancel button, Save button.")
    expect(value("Data processing")).toBe("The system stores the new name.")
    // Validation business + rule đã liên kết trùng nội dung ⇒ một dòng
    expect(value("Business rules")).toBe("Password must be hashed.")
  })

  it("function:<id> không phải primary_function_id của màn — không nhúng ảnh screen_layout", () => {
    const withSecondFn: Spine = { ...spine(), functions: [...spine().functions, { id: "FN03", screen_id: "S01", feature_id: "F1", order: 1, name: "Toggle", trigger: "t", description: "d", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }] }
    const section = renderSection(withSecondFn, "function:FN03", ctx({ number: "3.2.2" }))
    expect(section.blocks.some((b) => b.type === "image")).toBe(false)
  })
})

describe("sectionHeadingOf", () => {
  it("trả tiêu đề fixed/feature/function", () => {
    expect(sectionHeadingOf(spine(), "fixed:5.1")).toBe("Business Rules")
    expect(sectionHeadingOf(spine(), "feature:F1")).toBe("Authentication")
    expect(sectionHeadingOf(spine(), "function:FN01")).toBe("Submit Credentials")
  })
})

describe("buildRecordOfChanges", () => {
  const change = (over: Partial<Parameters<typeof buildRecordOfChanges>[0][number]>) => ({
    txn: "t1",
    op: "set",
    reason: null,
    at: "2026-09-01T09:00:00.000Z",
    by: "u1",
    step_id: "S-2.1",
    path: "actors[id=A01].name",
    ...over
  })

  it("gộp theo txn, suy change_type từ tập op, gộp reason không trùng", () => {
    const rows = buildRecordOfChanges([
      change({ txn: "t1", op: "add", reason: "seed actor" }),
      change({ txn: "t1", op: "add", reason: "seed actor" }),
      change({ txn: "t2", op: "set", reason: "typo fix", at: "2026-09-02T09:00:00.000Z", by: "u2" })
    ])
    // T15 review T7: version = v0.<i+2> (i 0-based) — Spine bắt đầu spine_version=1, mỗi txn +1.
    expect(rows).toEqual([
      { date: "2026-09-01", version: "v0.2", change_type: "A", in_charge: "u1", description: "seed actor" },
      { date: "2026-09-02", version: "v0.3", change_type: "M", in_charge: "u2", description: "typo fix" }
    ])
  })

  it("FLF-204 (BUG-15): sổ sách của runner không vào §I", () => {
    const rows = buildRecordOfChanges([
      change({ txn: "t1", reason: "step-runner: elicit turn" }),
      change({ txn: "t2", reason: "gate: accept", at: "2026-09-02T09:00:00.000Z" }),
      change({ txn: "t3", reason: null, at: "2026-09-03T09:00:00.000Z" }),
      change({ txn: "t4", reason: "Đổi tên actor theo yêu cầu của khách", at: "2026-09-04T09:00:00.000Z" })
    ])
    expect(rows.map((r) => r.description)).toEqual(["Đổi tên actor theo yêu cầu của khách"])
  })

  it("FLF-204: mốc baseline luôn có một dòng, mô tả bằng tiếng Anh", () => {
    const rows = buildRecordOfChanges([
      change({ txn: "t1", op: "add", path: "baselines[id=BL001]", reason: "Ký baseline v1.0" }),
      change({ txn: "t1", op: "set", path: "steps[id=S-9.5].status", reason: "step-runner: init step" })
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe("Baseline v1.0 signed")
  })

  it("changes rỗng ⇒ mảng rỗng", () => {
    expect(buildRecordOfChanges([])).toEqual([])
  })

  it("không truyền resolveInCharge ⇒ giữ nguyên by thô (mặc định identity)", () => {
    const rows = buildRecordOfChanges([change({ by: "650000000000000000000010", reason: "khách yêu cầu" })])
    expect(rows[0].in_charge).toBe("650000000000000000000010")
  })

  it("review T7: resolveInCharge được gọi với by của change đầu lô để tra tên hiển thị", () => {
    const rows = buildRecordOfChanges(
      [
        change({ txn: "t1", by: "650000000000000000000010", reason: "khách yêu cầu" }),
        change({ txn: "t2", by: "system", at: "2026-09-02T09:00:00.000Z", reason: "waive vì ngoài phạm vi bản này" })
      ],
      (by) => (by === "system" ? "System" : `Resolved:${by}`)
    )
    expect(rows[0].in_charge).toBe("Resolved:650000000000000000000010")
    expect(rows[1].in_charge).toBe("System")
  })
})
