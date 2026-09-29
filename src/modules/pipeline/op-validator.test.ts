import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { isWritablePath, normalizeSelectorPath, sanitizeModelOps, validateOps } from "./op-validator.js"
import { getStep } from "./step-registry.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

describe("validateOps", () => {
  it("lô hợp lệ ⇒ không lỗi, không đổi Spine", () => {
    const before = structuredClone(FIXTURE)
    expect(validateOps(FIXTURE, [{ op: "set", path: "actors[id=A01].name", value: "Owner" }], { writable: ["actors"] })).toEqual([])
    expect(FIXTURE).toEqual(before)
  })

  it("op sai hình (op hệ thống, thiếu path, không phải mảng)", () => {
    expect(validateOps(FIXTURE, [{ op: "migrate", path: "$", value: {} }])[0]).toMatchObject({ rule: "op_schema", op_index: 0 })
    expect(validateOps(FIXTURE, [{ op: "set", value: 1 }])[0]).toMatchObject({ rule: "op_schema" })
    expect(validateOps(FIXTURE, { ops: [] })[0]).toMatchObject({ rule: "op_schema" })
  })

  it("path ngoài quyền ghi của step", () => {
    const errors = validateOps(FIXTURE, [{ op: "set", path: "nfrs[id=N05].metric", value: "x" }], { writable: ["actors", "assumptions"], stepId: "S-3.1" })
    expect(errors).toMatchObject([{ rule: "path_not_writable", path: "nfrs[id=N05].metric" }])
  })

  it("lỗi op engine: path không phân giải, đổi khoá, bất biến", () => {
    expect(validateOps(FIXTURE, [{ op: "set", path: "actors[id=A99].name", value: "x" }])[0].rule).toBe("path_not_resolved")
    expect(validateOps(FIXTURE, [{ op: "set", path: "glossary[id=G07].id", value: "G99" }])[0].rule).toBe("key_change_forbidden")
    const rules = validateOps(FIXTURE, [{ op: "set", path: "functions[id=FN001].feature_id", value: "F2" }]).map((e) => e.rule)
    expect(rules).toContain("invariant_6_feature_mismatch")
  })

  it("isWritablePath theo gốc path", () => {
    expect(isWritablePath("project.release_scope.in", ["project"])).toBe(true)
    expect(isWritablePath("actors[id=A01]", ["actors"])).toBe(true)
    expect(isWritablePath("actors_extra", ["actors"])).toBe(false)
    expect(isWritablePath("progress.screen_queue[]", ["progress"])).toBe(true)
  })

  it("FLF-221: writes dạng dot-path — B-0.2 ghi được project.form_factor, không ghi được project.complexity", () => {
    const writable = getStep("B-0.2").writes
    expect(validateOps(FIXTURE, [{ op: "set", path: "project.form_factor", value: "mobile_app" }], { writable, stepId: "B-0.2" })).toEqual([])
    const errors = validateOps(FIXTURE, [{ op: "set", path: "project.complexity", value: "high" }], { writable, stepId: "B-0.2" })
    expect(errors).toMatchObject([{ rule: "path_not_writable", path: "project.complexity" }])
  })

  it("FLF-221: mọi op-case b0-s1 nằm trong writes của step (reads/writes Brief đã thu hẹp)", () => {
    const dir = path.resolve(__dirname, "../../../fixtures/op-cases/b0-s1")
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const opCase = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { step_id: string; ops: { path: string }[] }
      const writable = getStep(opCase.step_id).writes
      for (const op of opCase.ops) expect(isWritablePath(op.path, writable), `${file}: ${op.path}`).toBe(true)
    }
  })
})

describe("validateOps — luật ERD lúc sinh (S-4.5)", () => {
  const ERD: Spine = { ...structuredClone(FIXTURE), entities: [] }
  const entity = (id: string, name: string, relations: string[] = [], relation_verbs?: Record<string, string>) => ({
    op: "add",
    path: "entities[]",
    value: { id, name, description: `${name}.`, relations, ...(relation_verbs ? { relation_verbs } : {}) }
  })
  /** Entity không là con của ai trong lô ⇒ đánh dấu root, để test luật khác không vướng `erd_dependent_without_parent`. */
  const withRoots = (ops: unknown[]): unknown[] => {
    const values = ops.flatMap((o) => ((o as { path?: string }).path === "entities[]" ? [(o as { value: { id: string; relations: string[] } }).value] : []))
    const children = new Set(values.flatMap((v) => v.relations.filter((t) => t !== v.id)))
    return ops.map((o) => {
      const op = o as { path?: string; value?: { id: string } }
      return op.path === "entities[]" && op.value && !children.has(op.value.id) ? { ...op, value: { ...op.value, root: true } } : o
    })
  }
  const rules = (ops: unknown[]) => validateOps(ERD, withRoots(ops), { writable: ["entities", "assumptions"], stepId: "S-4.5" }).map((e) => e.rule)

  it("ERD liên thông, đủ động từ ⇒ qua", () => {
    expect(rules([entity("E01", "Project", ["E02", "E03"], { E02: "contains", E03: "has" }), entity("E02", "Version"), entity("E03", "Chat")])).toEqual([])
  })

  it("entity đứng riêng hoặc cụm tách rời ⇒ từ chối cả lô, nêu tên entity", () => {
    const errors = validateOps(
      ERD,
      withRoots([entity("E01", "Project", ["E02"], { E02: "contains" }), entity("E02", "Version"), entity("E03", "Wallet", ["E04"], { E04: "holds" }), entity("E04", "Reservation"), entity("E05", "Lonely")]),
      { writable: ["entities"], stepId: "S-4.5" }
    )
    expect(errors.map((e) => e.rule)).toEqual(["erd_disconnected"])
    expect(errors[0].message).toContain('"Wallet"')
    expect(errors[0].message).toContain('"Lonely" không có quan hệ')
  })

  it("thiếu động từ, động từ thừa, cặp trỏ lẫn nhau ⇒ từ chối", () => {
    expect(rules([entity("E01", "Project", ["E02"]), entity("E02", "Version")])).toEqual(["erd_relation_verb_missing"])
    expect(rules([entity("E01", "Project", ["E02"], { E02: "contains", E09: "has" }), entity("E02", "Version")])).toEqual(["erd_relation_verb_extra"])
    const oneToOneStray = { ...entity("E01", "Project", ["E02"], { E02: "contains" }) }
    ;(oneToOneStray.value as Record<string, unknown>).relation_cardinality = { E07: "1" }
    expect(rules([oneToOneStray, entity("E02", "Version")])).toEqual(["erd_relation_verb_extra"])
    expect(rules([entity("E01", "Paper", ["E02"], { E02: "includes" }), entity("E02", "Question", ["E01"], { E01: "appears in" })])).toEqual(["erd_many_to_many"])
  })

  it("vòng cha–con ≥ 3 entity ⇒ erd_relation_cycle; cây tự thân không tính", () => {
    const cycle = validateOps(
      ERD,
      [entity("E01", "Room", ["E02"], { E02: "hosts" }), entity("E02", "Slot", ["E03"], { E03: "accepts" }), entity("E03", "Booking", ["E01"], { E01: "reserves" })],
      { writable: ["entities"], stepId: "S-4.5" }
    )
    expect(cycle.map((e) => e.rule)).toEqual(["erd_relation_cycle"])
    expect(cycle[0].message).toContain('"Room", "Slot", "Booking"')
    expect(rules([entity("E01", "Comment", ["E01", "E02"], { E01: "replies to", E02: "has" }), entity("E02", "Reaction")])).toEqual([])
  })

  it("động từ bị động / con → cha, tên trùng, tên kiểu màn hình ⇒ từ chối", () => {
    for (const verb of ["belongs to", "is part of", "owned by", "is created"]) {
      expect(rules([entity("E01", "Project", ["E02"], { E02: verb }), entity("E02", "Version")])).toEqual(["erd_relation_verb_passive"])
    }
    for (const verb of ["contains", "consists of", "appears in", "hosts"]) {
      expect(rules([entity("E01", "Project", ["E02"], { E02: verb }), entity("E02", "Version")])).toEqual([])
    }
    expect(rules([entity("E01", "Exam", ["E02"], { E02: "has" }), entity("E02", "exam")])).toEqual(["erd_duplicate_name"])
    expect(rules([entity("E01", "Exam List", ["E02"], { E02: "has" }), entity("E02", "Order Detail")])).toEqual(["erd_entity_name_invalid"])
  })

  it("mô tả nhắc tên entity khác mà không nối trực tiếp / không chung con ⇒ erd_description_unlinked", () => {
    const describe = (id: string, name: string, description: string, relations: string[] = [], relation_verbs?: Record<string, string>) => {
      const op = entity(id, name, relations, relation_verbs)
      ;(op.value as Record<string, unknown>).description = description
      return op
    }
    const room = describe("E01", "Exam Room", "One room that provides seats for exam slots.", ["E03"], { E03: "provides" })
    const slot = describe("E02", "Exam Slot", "One timed sitting.", ["E03"], { E03: "places" })
    const seat = describe("E03", "Seat Assignment", "One seat in one exam room for one exam slot.")
    const user = describe("E04", "User", "One account.", ["E05"], { E05: "makes" })
    const registration = describe("E05", "Exam Registration", "One registration for one exam slot.")
    // Room ↔ Slot chung con Seat Assignment ⇒ qua; Registration nhắc Exam Slot mà Slot không phải cha/tổ tiên ⇒ chặn
    // (User nối vào Seat Assignment cho liên thông, Slot không nằm trên chuỗi cha của Registration)
    const userToSeat = describe("E04", "User", "One account.", ["E03", "E05"], { E03: "takes", E05: "makes" })
    const errors = validateOps(ERD, withRoots([room, slot, seat, userToSeat, registration]), { writable: ["entities"], stepId: "S-4.5" })
    expect(errors.map((e) => e.rule)).toEqual(["erd_description_unlinked"])
    expect(errors[0].message).toContain('"Exam Slot"')
    const fixed = describe("E02", "Exam Slot", "One timed sitting.", ["E03", "E05"], { E03: "places", E05: "accepts" })
    const userFixed = describe("E04", "User", "One account.", ["E05"], { E05: "makes" })
    expect(rules([room, fixed, seat, userFixed, registration])).toEqual([])
    expect(rules([room, slot, seat, describe("E04", "User", "One account.", ["E01"], { E01: "manages" })])).toEqual([])
  })

  it("mô tả nhắc tổ tiên (qua chuỗi cha → con) ⇒ qua — không đòi cạnh tắt trái luật no-shortcut", () => {
    const describe = (id: string, name: string, description: string, relations: string[] = [], relation_verbs?: Record<string, string>) => {
      const op = entity(id, name, relations, relation_verbs)
      ;(op.value as Record<string, unknown>).description = description
      return op
    }
    expect(
      rules([
        describe("E01", "User", "One account.", ["E02"], { E02: "takes" }),
        describe("E02", "Invigilator Assignment", "One duty of a user.", ["E03"], { E03: "receives" }),
        describe("E03", "Swap Request", "One swap one user raises against one invigilator assignment.")
      ])
    ).toEqual([])
  })

  it("bản số 1 phải có giả định nêu tên entity con và dẫn id bằng chứng", () => {
    const cardinalityAssumption = (statement: string, rationale: string, status = "unconfirmed") => ({
      op: "add",
      path: "assumptions[]",
      value: { id: "AS98", path: "entities[id=E01].relation_cardinality", statement, rationale, origin_step_id: "S-4.5", status, confirmed_at: status === "confirmed" ? "2026-09-28T00:00:00.000Z" : null }
    })
    const registration = entity("E01", "Exam Registration", ["E02"], { E02: "produces" })
    ;(registration.value as Record<string, unknown>).relation_cardinality = { E02: "1" }
    const attempt = entity("E02", "Exam Attempt")
    expect(rules([registration, attempt])).toEqual(["erd_cardinality_unjustified"])
    expect(rules([registration, attempt, cardinalityAssumption("Each registration has one score.", "FN009")])).toEqual(["erd_cardinality_unjustified"])
    expect(rules([registration, attempt, cardinalityAssumption("Each exam registration leads to one exam attempt.", "No function allows a second one.")])).toEqual([
      "erd_cardinality_no_evidence"
    ])
    expect(rules([registration, attempt, cardinalityAssumption("Each exam registration leads to one exam attempt.", "FN009 creates a new registration for a retake.")])).toEqual([])
    expect(rules([registration, attempt, cardinalityAssumption("Each exam registration leads to one exam attempt.", "Confirmed by the user.", "confirmed")])).toEqual([])
  })

  it("giả định trỏ relation_cardinality mà entity không đặt ⇒ erd_cardinality_unset", () => {
    const assumption = {
      op: "add",
      path: "assumptions[]",
      value: { id: "AS99", path: "entities[id=E01].relation_cardinality", statement: "One project has one version.", rationale: "FN001 keeps a single version.", origin_step_id: "S-4.5", status: "unconfirmed", confirmed_at: null }
    }
    expect(rules([entity("E01", "Project", ["E02"], { E02: "contains" }), entity("E02", "Version"), assumption])).toEqual(["erd_cardinality_unset", "erd_cardinality_contradiction"])
    const marked = entity("E01", "Project", ["E02"], { E02: "contains" })
    ;(marked.value as Record<string, unknown>).relation_cardinality = { E02: "1" }
    expect(rules([marked, entity("E02", "Version"), assumption])).toEqual([])
  })

  it("ví dụ trong skill entities-erd qua đủ luật ERD (ví dụ không được vi phạm chính skill)", () => {
    const md = fs.readFileSync(path.resolve(__dirname, "../../../assets/skills/content/entities-erd/SKILL.md"), "utf8")
    const example = JSON.parse(/## Example\s+```json\s+([\s\S]*?)```/.exec(md)![1]) as { ops: unknown[] }
    expect(validateOps(ERD, example.ops, { writable: ["entities", "assumptions"], stepId: "S-4.5" })).toEqual([])
  })

  it("động từ đọc con → cha dạng khác bị động (assigned to, linked to, derived from…) ⇒ từ chối; replies to của cây tự thân thì qua", () => {
    for (const verb of ["assigned to", "belonging to", "linked to", "related to", "derived from", "contained in", "applies to"]) {
      expect(rules([entity("E01", "Room", ["E02"], { E02: verb }), entity("E02", "Seat")]), verb).toEqual(["erd_relation_verb_passive"])
    }
    expect(rules([entity("E01", "Comment", ["E01", "E02"], { E01: "replies to", E02: "has" }), entity("E02", "Reaction")])).toEqual([])
  })

  it("entity không cha mà không khai root ⇒ erd_dependent_without_parent", () => {
    const floating = [
      entity("E01", "Exam Paper", ["E02"], { E02: "contains" }),
      entity("E02", "Paper Question"),
      { ...entity("E03", "Question", ["E02"], { E02: "appears in" }), value: { ...entity("E03", "Question", ["E02"], { E02: "appears in" }).value, root: true } }
    ]
    const errors = validateOps(ERD, floating, { writable: ["entities"], stepId: "S-4.5" })
    expect(errors.map((e) => e.rule)).toEqual(["erd_dependent_without_parent"])
    expect(errors[0].message).toContain('"Exam Paper"')
  })

  it("relation_optional trỏ id ngoài relations ⇒ erd_relation_verb_extra", () => {
    const batch = entity("E01", "Import Batch", ["E02"], { E02: "creates" })
    ;(batch.value as Record<string, unknown>).relation_optional = ["E09"]
    expect(rules([batch, entity("E02", "Registration")])).toEqual(["erd_relation_verb_extra"])
    ;(batch.value as Record<string, unknown>).relation_optional = ["E02"]
    expect(rules([batch, entity("E02", "Registration")])).toEqual([])
  })

  it("giả định dựa vào 'one X' mà cạnh cha → X vẫn N ⇒ erd_cardinality_contradiction", () => {
    const attempt = entity("E01", "Exam Attempt", ["E02"], { E02: "produces" })
    const score = entity("E02", "Score Record", ["E03"], { E03: "receives" })
    ;(score.value as Record<string, unknown>).relation_cardinality = { E03: "1" }
    const as75 = {
      op: "add",
      path: "assumptions[]",
      value: { id: "AS75", path: "entities[id=E02].relation_cardinality", statement: "A score record receives at most one regrade appeal.", rationale: "BR55 allows one appeal per exam attempt, and the attempt produces one score record.", origin_step_id: "S-4.5", status: "unconfirmed", confirmed_at: null }
    }
    expect(rules([attempt, score, entity("E03", "Regrade Appeal"), as75])).toEqual(["erd_cardinality_contradiction"])
  })

  it("giả định đã xác nhận nói nhiều–nhiều mà ERD nối thẳng ⇒ erd_confirmed_many_to_many; qua entity trung gian thì qua", () => {
    const as30 = { id: "AS30", path: "entities[id=E02]", statement: "A question can appear in many exam papers and a paper contains many questions.", rationale: "Confirmed by the user.", origin_step_id: "S-4.5", status: "confirmed" as const, confirmed_at: "2026-09-28T00:00:00.000Z" }
    const withAs30: Spine = { ...ERD, assumptions: [as30] }
    const course = (children: string[]) => ({ ...entity("E01", "Course", children, Object.fromEntries(children.map((c) => [c, "owns"]))), value: { ...entity("E01", "Course").value, relations: children, relation_verbs: Object.fromEntries(children.map((c) => [c, "owns"])), root: true } })
    const direct = [course(["E02", "E03"]), entity("E02", "Exam Paper", ["E03"], { E03: "contains" }), entity("E03", "Question")]
    expect(validateOps(withAs30, withRoots(direct), { writable: ["entities"], stepId: "S-4.5" }).map((e) => e.rule)).toEqual(["erd_confirmed_many_to_many"])
    const resolved = [
      course(["E02", "E03"]),
      entity("E02", "Exam Paper", ["E04"], { E04: "contains" }),
      entity("E03", "Question", ["E04"], { E04: "appears in" }),
      entity("E04", "Paper Question")
    ]
    expect(validateOps(withAs30, withRoots(resolved), { writable: ["entities"], stepId: "S-4.5" })).toEqual([])
  })

  it("lô chỉ xoá giả định đang làm bằng chứng cho '1' cũng bị soi ERD", () => {
    const spine: Spine = {
      ...ERD,
      entities: [
        { id: "E01", name: "Exam Registration", description: "One registration.", root: true, relations: ["E02"], relation_verbs: { E02: "produces" }, relation_cardinality: { E02: "1" } },
        { id: "E02", name: "Exam Attempt", description: "One attempt.", relations: [] }
      ],
      assumptions: [{ id: "AS01", path: "entities[id=E01].relation_cardinality", statement: "One exam registration leads to one exam attempt.", rationale: "FN009.", origin_step_id: "S-4.5", status: "unconfirmed", confirmed_at: null }]
    }
    expect(validateOps(spine, [{ op: "remove", path: "assumptions[id=AS01]" }], { writable: ["assumptions"] }).map((e) => e.rule)).toEqual(["erd_cardinality_unjustified"])
  })

  it("lô không đụng entities ⇒ không soi ERD (Spine cũ thiếu động từ vẫn sửa được phần khác)", () => {
    expect(validateOps(FIXTURE, [{ op: "set", path: "actors[id=A01].name", value: "Owner" }], { writable: ["actors"] })).toEqual([])
  })
})

describe("sanitizeModelOps — path của giả định", () => {
  it("selector thiếu tên khoá được chuẩn hoá thay vì làm hỏng cả lô", () => {
    expect(normalizeSelectorPath("addendum[AD8]")).toBe("addendum[id=AD8]")
    expect(normalizeSelectorPath("nfrs[N03].threshold")).toBe("nfrs[id=N03].threshold")
    // Path đã đúng, path gốc và giá trị không phải chuỗi thì giữ nguyên
    expect(normalizeSelectorPath("actors[id=A01].name")).toBe("actors[id=A01].name")
    expect(normalizeSelectorPath("project.vision")).toBe("project.vision")
    expect(normalizeSelectorPath(42)).toBe(42)
  })

  it("add assumptions[] với path viết tắt ⇒ áp được, không còn dead_reference", () => {
    const raw = [
      {
        op: "add",
        path: "assumptions[]",
        value: {
          path: `addendum[${FIXTURE.addendum[0].id}]`,
          statement: "Giả định demo",
          rationale: "Vì user chưa nói rõ",
          origin_step_id: "B-1.2",
          status: "unconfirmed",
          confirmed_at: null
        }
      }
    ]
    const sanitized = sanitizeModelOps(FIXTURE, raw, "B-1.2")
    expect(sanitized.errors).toEqual([])
    expect((sanitized.ops[0] as { value: { path: string } }).value.path).toBe(`addendum[id=${FIXTURE.addendum[0].id}]`)
    expect(validateOps(FIXTURE, sanitized.ops, { writable: ["assumptions"] })).toEqual([])
  })

  it("add assumptions[] trùng câu của giả định đã có (khác hoa/thường, dấu câu cuối) ⇒ lỗi, không thêm lại", () => {
    const existing = {
      id: "AS90",
      path: "project.stakes",
      statement: "Hospital has server infrastructure.",
      statement_vi: "Bệnh viện đã có hạ tầng máy chủ.",
      rationale: "demo",
      origin_step_id: "B-1.1",
      status: "confirmed" as const,
      confirmed_at: "2026-09-30T00:00:00.000Z"
    }
    const spine: Spine = { ...FIXTURE, assumptions: [...FIXTURE.assumptions, existing] }
    const raw = [{ op: "add", path: "assumptions[]", value: { path: "project.stakes", statement: "x", statement_vi: "bệnh viện đã có hạ tầng máy chủ", origin_step_id: "B-2.3" } }]
    const { errors } = sanitizeModelOps(spine, raw, "B-2.3")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ rule: "op_not_allowed", op_index: 0 })
    expect(errors[0].message).toContain("AS90")
  })
})

describe("sanitizeModelOps — giá trị form_factor / stakes", () => {
  it("chuỗi ghép nhiều nền tảng hoặc giá trị lạ ⇒ lỗi kèm tập giá trị hợp lệ; giá trị đúng thì qua", () => {
    const bad = sanitizeModelOps(FIXTURE, [
      { op: "set", path: "project.form_factor", value: "web_app,mobile_app" },
      { op: "set", path: "project", value: { ...FIXTURE.project, stakes: "high" } }
    ], "B-0.1")
    expect(bad.errors.map((e) => e.op_index)).toEqual([0, 1])
    expect(bad.errors[0].message).toContain("mobile_app")
    const good = sanitizeModelOps(FIXTURE, [
      { op: "set", path: "project.form_factor", value: "mobile_app" },
      { op: "set", path: "project.stakes", value: null }
    ], "B-0.1")
    expect(good.errors).toEqual([])
  })
})

describe("sanitizeModelOps — addendum", () => {
  it("add addendum[] ⇒ captured_at là giờ server, không phải ngày model viết", () => {
    const now = new Date("2026-09-30T01:40:00.000Z")
    const raw = [{ op: "add", path: "addendum[]", value: { topic: "scale", content: "50 người", content_en: "50 users", target_section: "fixed:4.2.3", captured_at: "2024-01-01T00:00:00.000Z" } }]
    const sanitized = sanitizeModelOps(FIXTURE, raw, "B-1.4", now)
    expect((sanitized.ops[0] as { value: { captured_at: string } }).value.captured_at).toBe("2026-09-30T01:40:00.000Z")
  })
})
