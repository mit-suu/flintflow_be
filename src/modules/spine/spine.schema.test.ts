import fs from "node:fs"
import path from "node:path"
import { describe, it, expect } from "vitest"
import {
  baselineSchema,
  baselineSnapshotSchema,
  changeSchema,
  serializeJsonSchema,
  spineSchema,
  toJsonSchema,
  usageSchema
} from "./spine.schema.js"
import { createEmptySpine } from "./spine.repository.js"
import { getAssetsRoot } from "../../config/paths.js"
import type { Change, Spine, Usage } from "./spine.types.js"

const AT = "2026-09-14T08:00:00.000Z"

/** Spine nhỏ chạm mọi mảng — không phải fixture T02, chỉ để phủ schema. */
const sampleSpine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen", domain: "E-learning" })
  s.project.vision = "Help small teachers sell courses online"
  s.project.goals = ["Launch MVP"]
  s.project.working_mode = "coaching"
  s.project.release_scope = { in: ["Course catalog"], out: ["Mobile app"] }
  s.progress = {
    current_phase: "S-5",
    current_step: "S-5.1",
    screen_cursor: "S1",
    screen_queue: ["S1"],
    elicit_turns_this_phase: 2
  }
  s.steps = [{ id: "S-5.1@S1", status: "accepted", first_seq: 1, last_seq: 3, accepted_at: AT }]
  s.features = [{ id: "F1", name: "Course management", order: 0 }]
  s.actors = [
    { id: "A01", name: "Student", kind: "human", description: "Learner" },
    { id: "A02", name: "Payment gateway", kind: "system", description: "" }
  ]
  s.roles = [{ id: "R1", name: "Student", actor_id: "A01" }]
  s.use_cases = [
    {
      id: "UC1",
      name: "Browse courses",
      actor_ids: ["A01"],
      function_ids: ["FN1"],
      description: "",
      includes: [],
      extends: []
    }
  ]
  s.screens = [
    {
      id: "S1",
      feature_id: "F1",
      name: "Course list",
      description: "",
      flow_to: [],
      is_popup: false,
      tabs: [],
      primary_function_id: "FN1",
      queue_order: 0,
      detail_status: "in_progress"
    }
  ]
  s.permissions = [{ id: "P1", screen_id: "S1", role_id: "R1", action: "read" }]
  s.entities = [{ id: "E1", name: "Course", description: "", relations: [] }]
  s.functions = [
    {
      id: "FN1",
      screen_id: "S1",
      feature_id: "F1",
      order: 0,
      name: "View courses",
      trigger: "User opens the screen",
      description: "",
      normal: ["System lists published courses"],
      abnormal: [],
      validations: [{ id: "V1", kind: "required", statement: "Keyword is required" }],
      business_rule_ids: ["BR1"],
      priority: null
    }
  ]
  s.nfrs = [
    {
      id: "N1",
      category: "performance",
      statement: "Course list loads quickly",
      kind: "quantitative",
      metric: "p95 page load",
      threshold: "2s",
      priority: "must"
    }
  ]
  s.business_rules = [{ id: "BR1", tier: "detail", statement: "Only published", source_validation_ids: ["V1"] }]
  s.common_requirements = [{ id: "CR1", category: "logging", statement: "Log every login" }]
  s.messages = [{ id: "M1", code: "MSG01", text: "Not found", function_ids: ["FN1"] }]
  s.other_requirements = [{ id: "O1", kind: "risk", statement: "Payment provider downtime" }]
  s.glossary = [{ id: "G1", term: "Course", term_native: "Khoá học", definition: "A sellable unit" }]
  s.addendum = [
    { id: "AD1", topic: "Refund", content: "Hoàn tiền", content_en: "Refund", target_section: "fixed:5.4", captured_at: AT }
  ]
  s.diagrams = [
    {
      id: "D1",
      kind: "usecase",
      puml: "@startuml\n@enduml",
      section: "fixed:2.2.1",
      owner_kind: null,
      owner_id: null,
      render_status: "ok",
      source_hash: "abc",
      rendered_at: AT
    }
  ]
  s.assumptions = [
    {
      id: "AS1",
      path: "nfrs[id=N1].threshold",
      statement: "2s is acceptable",
      rationale: "Typical",
      origin_step_id: "S-6.3",
      status: "unconfirmed",
      confirmed_at: null
    }
  ]
  s.flags = [
    {
      id: "FL1",
      level: "red",
      rule_id: "section_empty",
      section_id: "fixed:5.2",
      target_id: null,
      message: "Section is empty",
      remediation_step: "S-7.2",
      opened_at_version: 1,
      resolved_at: null,
      waived_by_user: true,
      waive_reason: "Out of scope for the first release",
      waived_at_version: 1
    }
  ]
  s.sections = [{ id: "fixed:1", asset_version: "1.0.0" }]
  s.baselines = [
    { id: "B1", version: "v1.0-conditional", type: "generated", doc_version: null, at: AT, snapshot_ref: "650000000000000000000009", checked_at_version: 4, waived_count: 1 }
  ]
  s.spine_version = 5
  return s
}

describe("spineSchema", () => {
  it("Spine rỗng hợp lệ", () => {
    const result = spineSchema.safeParse(createEmptySpine())
    expect(result.success, result.error?.message).toBe(true)
  })

  it("Spine đủ mọi mảng hợp lệ", () => {
    const result = spineSchema.safeParse(sampleSpine())
    expect(result.success, result.error?.message).toBe(true)
  })

  it.each<[string, (s: Spine) => void]>([
    ["actors[].kind", (s) => (s.actors[0].kind = "robot" as never)],
    ["screens[].detail_status", (s) => (s.screens[0].detail_status = "done" as never)],
    ["steps[].status", (s) => (s.steps[0].status = "regenerated" as never)],
    ["project.working_mode", (s) => (s.project.working_mode = "slow" as never)],
    ["flags[].level", (s) => (s.flags[0].level = "orange" as never)],
    ["nfrs[].category", (s) => (s.nfrs[0].category = "security" as never)],
    ["functions[].priority", (s) => (s.functions[0].priority = "high" as never)],
    ["diagrams[].kind", (s) => (s.diagrams[0].kind = "sequence" as never)],
    ["assumptions[].status", (s) => (s.assumptions[0].status = "maybe" as never)]
  ])("từ chối enum sai: %s", (_label, mutate) => {
    const s = sampleSpine()
    mutate(s)
    expect(spineSchema.safeParse(s).success).toBe(false)
  })

  it("từ chối status lưu trong sections[] (A7 — status là hàm tính)", () => {
    const s = sampleSpine()
    Object.assign(s.sections[0], { status: "accepted" })
    expect(spineSchema.safeParse(s).success).toBe(false)
  })

  it("từ chối key lạ ở gốc (ví dụ progressPercent)", () => {
    expect(spineSchema.safeParse({ ...createEmptySpine(), progressPercent: 40 }).success).toBe(false)
  })

  it("từ chối waive_reason ngắn hơn 20 ký tự", () => {
    const s = sampleSpine()
    s.flags[0].waive_reason = "too short"
    expect(spineSchema.safeParse(s).success).toBe(false)
  })

  it("từ chối spine_version < 1 và thời điểm không phải ISO", () => {
    expect(spineSchema.safeParse({ ...createEmptySpine(), spine_version: 0 }).success).toBe(false)

    const s = sampleSpine()
    s.steps[0].accepted_at = "hôm qua"
    expect(spineSchema.safeParse(s).success).toBe(false)
  })
})

describe("baselineSchema — type / doc_version (FLF-171, contract-change mode 1)", () => {
  const legacy = { id: "B1", version: "v1.0", at: AT, snapshot_ref: "650000000000000000000009", checked_at_version: 4, waived_count: 0 }

  it("baseline cũ (trước FLF-171) không có type/doc_version ⇒ đọc ra generated / null", () => {
    const parsed = baselineSchema.parse(legacy)
    expect(parsed.type).toBe("generated")
    expect(parsed.doc_version).toBeNull()
  })

  it("Spine cũ có baselines thiếu field mới vẫn hợp lệ", () => {
    const s = createEmptySpine({ name: "Old" }) as unknown as Record<string, unknown>
    s.baselines = [legacy]
    const result = spineSchema.safeParse(s)
    expect(result.success, result.error?.message).toBe(true)
    expect(result.data?.baselines[0].type).toBe("generated")
  })

  it.each(["imported", "release"] as const)("mode 1: type %s kèm doc_version", (type) => {
    const parsed = baselineSchema.parse({ ...legacy, version: type === "imported" ? "0.0" : "1.0", type, doc_version: type === "imported" ? "0.0" : "1.0" })
    expect(parsed.type).toBe(type)
    expect(parsed.doc_version).toBe(type === "imported" ? "0.0" : "1.0")
  })

  it.each<[string, Record<string, unknown>]>([
    ["type lạ", { type: "draft" }],
    ["doc_version rỗng", { doc_version: "" }]
  ])("từ chối %s", (_label, patch) => {
    expect(baselineSchema.safeParse({ ...legacy, ...patch }).success).toBe(false)
  })

  it("snapshot baseline cũ trong collection baselines vẫn parse được", () => {
    const parsed = baselineSnapshotSchema.parse({ projectId: "650000000000000000000001", version: "v1.0", at: AT, checked_at_version: 1, waived_count: 0, snapshot: createEmptySpine({ name: "Old" }) })
    expect(parsed.type).toBe("generated")
    expect(parsed.doc_version).toBeNull()
  })
})

describe("changeSchema / usageSchema", () => {
  const change: Change = {
    projectId: "650000000000000000000001",
    seq: 1,
    txn: "txn-1",
    op: "set",
    path: "actors[id=A01].name",
    before: null,
    value: "Student",
    reason: null,
    at: AT,
    by: "650000000000000000000002",
    step_id: "S-2.1"
  }
  const usage: Usage = {
    projectId: "650000000000000000000001",
    userId: "650000000000000000000002",
    step_id: "S-2.1",
    call_kind: "draft",
    attempt: 1,
    tokens_in: 1200,
    tokens_out: 300,
    cost: 2,
    state: "reserved",
    expires_at: AT,
    logId: null
  }

  it("change và usage hợp lệ", () => {
    expect(changeSchema.safeParse(change).success).toBe(true)
    expect(usageSchema.safeParse(usage).success).toBe(true)
  })

  it("từ chối change seq < 1 và usage state sai", () => {
    expect(changeSchema.safeParse({ ...change, seq: 0 }).success).toBe(false)
    expect(usageSchema.safeParse({ ...usage, state: "pending" }).success).toBe(false)
  })
})

describe("fixture Spine của T02", () => {
  const fixturesDir = path.join(path.dirname(getAssetsRoot()), "fixtures")
  const fixtureFiles = fs.existsSync(fixturesDir)
    ? fs
        .readdirSync(fixturesDir, { recursive: true, encoding: "utf8" })
        .filter((file) => /spine.*\.json$/i.test(path.basename(file)))
    : []

  // T02 chưa merge thì bỏ qua; khi có fixture, mọi file spine*.json phải parse được
  it.skipIf(fixtureFiles.length === 0)("mọi fixtures/**/spine*.json parse qua spineSchema", () => {
    for (const file of fixtureFiles) {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8"))
      const result = spineSchema.safeParse(raw)
      expect(result.success, `${file}: ${result.error?.message}`).toBe(true)
    }
  })
})

describe("JSON Schema", () => {
  it("có đủ field gốc và cấm key lạ", () => {
    const schema = toJsonSchema()
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties as object)).toEqual(Object.keys(spineSchema.shape))
  })

  it("assets/schema/srs-spine.schema.json khớp schema hiện tại (chạy npm run schema:export)", () => {
    const file = path.join(getAssetsRoot(), "schema", "srs-spine.schema.json")
    expect(fs.existsSync(file), `Thiếu ${file}`).toBe(true)
    const onDisk = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")
    expect(onDisk).toBe(serializeJsonSchema())
  })
})
