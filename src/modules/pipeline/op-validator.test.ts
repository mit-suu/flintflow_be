import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { briefExtractionErrors, dropRedundantScalarAdds, isWritablePath, normalizeSelectorPath, sanitizeModelOps, useCaseWiringErrors, validateOps } from "./op-validator.js"
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

  it("add assumptions[] diễn lại gần nghĩa giả định đã xác nhận (thêm chi tiết) ⇒ lỗi; giả định khác cùng chủ đề ⇒ qua", () => {
    const as9 = {
      id: "AS90",
      path: "nfrs[id=N01].threshold",
      statement: "About 200 patients use the app/web at the same time during peak hours.",
      statement_vi: "Giờ cao điểm có khoảng 200 bệnh nhân dùng app/web cùng lúc.",
      rationale: "demo",
      origin_step_id: "B-2.2",
      status: "confirmed" as const,
      confirmed_at: "2026-09-30T00:00:00.000Z"
    }
    const spine: Spine = { ...FIXTURE, assumptions: [...FIXTURE.assumptions, as9] }
    const restated = {
      op: "add",
      path: "assumptions[]",
      value: {
        path: "nfrs[id=N01].threshold",
        statement: "Peak hours see about 200 concurrent app/web users on top of 800–1,000 visits a day.",
        statement_vi: "Giờ cao điểm có khoảng 200 người dùng app/web cùng lúc, ngoài 800–1.000 lượt khám mỗi ngày.",
        origin_step_id: "B-2.3"
      }
    }
    const different = {
      op: "add",
      path: "assumptions[]",
      value: {
        path: "nfrs[id=N01].threshold",
        statement: "Next-patient calls are sent through the mobile app with an SMS fallback.",
        statement_vi: "Thông báo gọi bệnh nhân kế tiếp gửi qua ứng dụng điện thoại, kèm tin nhắn SMS cho bệnh nhân chưa cài app.",
        origin_step_id: "B-2.3"
      }
    }
    const short = {
      op: "add",
      path: "assumptions[]",
      value: { path: "nfrs[id=N01].threshold", statement: "Peak 200 users.", statement_vi: "Cao điểm 200 người.", origin_step_id: "B-2.3" }
    }
    const negatedTwin = {
      op: "add",
      path: "assumptions[]",
      value: {
        path: "nfrs[id=N01].threshold",
        statement: "Peak hours do not reach 200 concurrent app/web users.",
        statement_vi: "Giờ cao điểm không tới 200 bệnh nhân dùng app/web cùng lúc.",
        origin_step_id: "B-2.3"
      }
    }
    const { errors } = sanitizeModelOps(spine, [restated, different, short, negatedTwin], "B-2.3")
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

  it("form_factor là mảng nền tảng: chuỗi đơn ⇒ mảng một phần tử, mảng giữ thứ tự và bỏ trùng, phần tử lạ ⇒ lỗi", () => {
    const { ops, errors } = sanitizeModelOps(FIXTURE, [
      { op: "set", path: "project.form_factor", value: "mobile_app" },
      { op: "set", path: "project.form_factor", value: ["web_app", "mobile_app", "web_app"] },
      { op: "set", path: "project", value: { ...FIXTURE.project, form_factor: "web_app" } },
      { op: "set", path: "project.form_factor", value: ["web_app", "smartwatch"] }
    ], "B-0.1")
    expect(errors.map((e) => e.op_index)).toEqual([3])
    expect(errors[0].message).toContain("mảng")
    expect(ops[0]).toMatchObject({ value: ["mobile_app"] })
    expect(ops[1]).toMatchObject({ value: ["web_app", "mobile_app"] })
    expect((ops[2] as { value: { form_factor: string[] } }).value.form_factor).toEqual(["web_app"])
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

describe("sanitizeModelOps — revision sửa giả định (FLF-232)", () => {
  const assumption = {
    id: "AS90",
    path: "project.form_factor",
    statement: "The product is a web app.",
    statement_vi: "Sản phẩm là ứng dụng web.",
    rationale: "demo",
    origin_step_id: "B-0.1",
    status: "unconfirmed" as const,
    confirmed_at: null
  }
  const spine: Spine = { ...FIXTURE, assumptions: [assumption] }
  const restate = [
    { op: "set", path: "assumptions[id=AS90].statement", value: "The product is a mobile app." },
    { op: "set", path: "assumptions[id=AS90].status", value: "confirmed" }
  ]
  const revision = { revision: true, gateAssumptionIds: new Set(["AS90"]) }

  it("status của giả định chỉ đổi được ở bước rà giả định — revision ở gate thì được, server đặt confirmed_at", () => {
    const status = [{ op: "set", path: "assumptions[id=AS90].status", value: "confirmed" }]
    // Lượt thường: không lỗi (không làm hỏng cả lô) nhưng status giữ nguyên
    const plain = sanitizeModelOps(spine, status, "B-0.3")
    expect(plain.errors).toEqual([])
    expect(plain.ops[0]).toMatchObject({ path: "assumptions[id=AS90].status", value: "unconfirmed" })
    const { errors, ops } = sanitizeModelOps(spine, status, "B-0.3", new Date("2026-09-30T00:00:00.000Z"), revision)
    expect(errors).toEqual([])
    expect(ops[ops.length - 1]).toMatchObject({ op: "set", path: "assumptions[id=AS90].confirmed_at", value: "2026-09-30T00:00:00.000Z" })
  })

  it("đổi câu + confirmed mà có set đúng path của giả định ⇒ hợp lệ", () => {
    const { errors } = sanitizeModelOps(spine, [{ op: "set", path: "project.form_factor", value: "mobile_app" }, ...restate], "B-0.3", new Date(), revision)
    expect(errors).toEqual([])
  })

  it("đổi câu + confirmed mà không ghi trường thật ⇒ assumption_path_mismatch, trỏ đúng op đổi câu", () => {
    const { errors } = sanitizeModelOps(spine, restate, "B-0.3", new Date(), revision)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ rule: "assumption_path_mismatch", op_index: 0, path: "assumptions[id=AS90].statement" })
  })

  it("set nhầm path (trường khác) ⇒ vẫn assumption_path_mismatch", () => {
    const { errors } = sanitizeModelOps(spine, [{ op: "set", path: "project.stakes", value: "regulated" }, ...restate], "B-0.3", new Date(), revision)
    expect(errors.map((e) => e.rule)).toEqual(["assumption_path_mismatch"])
  })

  it("set cả object project chứa trường ⇒ tính là ghi đúng path", () => {
    const { errors } = sanitizeModelOps(spine, [{ op: "set", path: "project", value: { ...FIXTURE.project, form_factor: "mobile_app" } }, ...restate], "B-0.3", new Date(), revision)
    expect(errors).toEqual([])
  })

  it("xác nhận nguyên câu (không đổi statement) hoặc bỏ giả định (rejected) không đòi ghi trường thật", () => {
    expect(sanitizeModelOps(spine, [{ op: "set", path: "assumptions[id=AS90].status", value: "confirmed" }], "B-0.3", new Date(), revision).errors).toEqual([])
    expect(sanitizeModelOps(spine, [{ op: "set", path: "assumptions[id=AS90].status", value: "rejected" }], "B-0.3", new Date(), revision).errors).toEqual([])
  })

  it("đổi câu mà để status unconfirmed hoặc bỏ op status ⇒ vẫn assumption_path_mismatch", () => {
    const noStatus = [restate[0]]
    expect(sanitizeModelOps(spine, noStatus, "B-0.3", new Date(), revision).errors.map((e) => e.rule)).toEqual(["assumption_path_mismatch"])
    const stillUnconfirmed = [restate[0], { op: "set", path: "assumptions[id=AS90].status", value: "unconfirmed" }]
    expect(sanitizeModelOps(spine, stillUnconfirmed, "B-0.3", new Date(), revision).errors.map((e) => e.rule)).toEqual(["assumption_path_mismatch"])
  })

  it("đổi câu qua cả object giả định cũng bị soi path", () => {
    const whole = [{ op: "set", path: "assumptions[id=AS90]", value: { ...assumption, statement: "The product is a mobile app.", status: "confirmed" } }]
    expect(sanitizeModelOps(spine, whole, "B-0.3", new Date(), revision).errors.map((e) => e.rule)).toEqual(["assumption_path_mismatch"])
  })

  it("giả định cũ chưa có statement_vi: điền thêm bản VI khi xác nhận không phải là viết lại câu", () => {
    const legacy: Spine = { ...FIXTURE, assumptions: [{ ...assumption, statement_vi: null }] }
    const ops = [
      { op: "set", path: "assumptions[id=AS90].statement_vi", value: "Sản phẩm là ứng dụng web." },
      { op: "set", path: "assumptions[id=AS90].status", value: "confirmed" }
    ]
    expect(sanitizeModelOps(legacy, ops, "B-0.3", new Date(), revision).errors).toEqual([])
  })

  it("revision chỉ đổi status của giả định cổng vừa nói — giả định khác (kể cả đã xác nhận) giữ nguyên status", () => {
    const other = { ...assumption, id: "AS91", path: "project.stakes", origin_step_id: "B-0.3", status: "confirmed" as const, confirmed_at: "2026-09-29T00:00:00.000Z" }
    const both: Spine = { ...FIXTURE, assumptions: [assumption, other] }
    const flip = [{ op: "set", path: "assumptions[id=AS91].status", value: "rejected" }]
    const { errors, ops } = sanitizeModelOps(both, flip, "B-0.3", new Date(), revision)
    expect(errors).toEqual([])
    expect(ops[0]).toMatchObject({ path: "assumptions[id=AS91].status", value: "confirmed" })
    const whole = [{ op: "set", path: "assumptions[id=AS91]", value: { ...other, status: "rejected" } }]
    const kept = sanitizeModelOps(both, whole, "B-0.3", new Date(), revision).ops[0] as { value: { status: string } }
    expect(kept.value.status).toBe("confirmed")
  })

  it("revision không có gateAssumptionIds ⇒ không giả định nào đổi được status", () => {
    const status = [{ op: "set", path: "assumptions[id=AS90].status", value: "confirmed" }]
    const { errors, ops } = sanitizeModelOps(spine, status, "B-0.3", new Date(), { revision: true })
    expect(errors).toEqual([])
    expect(ops).toEqual([{ op: "set", path: "assumptions[id=AS90].status", value: "unconfirmed" }])
  })

  it("luật path chỉ áp cho revision — lượt draft thường không bị ảnh hưởng", () => {
    expect(sanitizeModelOps(spine, restate, "B-2.1").errors).toEqual([])
  })
})

describe("validateOps — extraPaths cho revision ở cổng (giả định của bước khác)", () => {
  const writes = ["addendum", "assumptions"]
  const op = { op: "set", path: "project.form_factor", value: "mobile_app" }

  it("path ngoài writes bị chặn; nằm trong extraPaths (path thật của giả định cổng) thì được ghi", () => {
    expect(validateOps(FIXTURE, [op], { writable: writes, stepId: "B-1.3" })[0]).toMatchObject({ rule: "path_not_writable" })
    expect(validateOps(FIXTURE, [op], { writable: writes, stepId: "B-1.3", extraPaths: ["project.form_factor"] })).toEqual([])
  })

  it("extraPaths không mở rộng sang path khác, kể cả cùng cha", () => {
    const other = { op: "set", path: "project.stakes", value: "regulated" }
    expect(validateOps(FIXTURE, [other], { writable: writes, stepId: "B-1.3", extraPaths: ["project.form_factor"] })[0]).toMatchObject({ rule: "path_not_writable" })
  })

  it("selector viết tắt trong path giả định được chuẩn hoá khi so", () => {
    const actor = FIXTURE.actors[0]
    const edit = { op: "set", path: `actors[id=${actor.id}].name`, value: "Renamed" }
    expect(validateOps(FIXTURE, [edit], { writable: writes, stepId: "B-1.3", extraPaths: [`actors[${actor.id}].name`] })).toEqual([])
  })
})

describe("validateOps — Brief không ghi project.vision/goals", () => {
  const set = (path: string, value: unknown) => ({ op: "set", path, value })

  it("mọi step B-* bị từ chối set project.vision / project.goals, thông báo chỉ sang addendum", () => {
    for (const stepId of ["B-1.1", "B-1.6", "B-2.3", "B-0.1"]) {
      const writable = getStep(stepId).writes
      const errors = validateOps(FIXTURE, [set("project.vision", "A vision")], { writable: [...writable, "project"], stepId })
      expect(errors, stepId).toMatchObject([{ rule: "path_not_writable", path: "project.vision" }])
      expect(errors[0].message).toContain("addendum")
      expect(validateOps(FIXTURE, [set("project.goals", ["a"])], { writable: [...writable, "project"], stepId })[0]).toMatchObject({ rule: "path_not_writable" })
    }
  })

  it("set project có khoá vision/goals cũng bị chặn ở Brief; field project khác vẫn qua", () => {
    const writable = getStep("B-1.6").writes
    expect(validateOps(FIXTURE, [set("project", { ...FIXTURE.project, vision: "V" })], { writable, stepId: "B-1.6" })[0]).toMatchObject({ rule: "path_not_writable" })
    expect(validateOps(FIXTURE, [set("project.form_factor", "mobile_app")], { writable: getStep("B-0.3").writes, stepId: "B-0.3" })).toEqual([])
  })

  it("step ngoài Brief (S-2.1) vẫn ghi được project.vision", () => {
    expect(validateOps(FIXTURE, [set("project.vision", "A vision")], { writable: getStep("S-2.1").writes, stepId: "S-2.1" })).toEqual([])
  })

  it("B-1.1 ghi được addendum vision/goals", () => {
    const entry = { topic: "vision", content: "Tầm nhìn", content_en: "Vision", target_section: "fixed:1", captured_at: "2026-09-30T00:00:00.000Z" }
    expect(validateOps(FIXTURE, [{ op: "add", path: "addendum[]", value: entry }], { writable: getStep("B-1.1").writes, stepId: "B-1.1" })).toEqual([])
  })
})

describe("validateOps / briefExtractionErrors — S-1.1", () => {
  const core = (id: string, topic: string): Spine["addendum"][number] => ({
    id,
    topic,
    content: "Nội dung",
    content_en: "Content",
    target_section: "fixed:1",
    captured_at: "2026-09-30T00:00:00.000Z"
  })
  const withCore: Spine = { ...structuredClone(FIXTURE), addendum: [core("AD1", "vision"), core("AD2", "goals"), core("AD3", "goals"), { ...core("AD4", "Why now"), topic: "Why now" }] }
  const writable = getStep("S-1.1").writes
  const vision = { op: "set" as const, path: "project.vision", value: "One English sentence." }
  const goals = (n: number) => ({ op: "set" as const, path: "project.goals", value: Array.from({ length: n }, (_, i) => `Goal ${i + 1}`) })

  it("registry: S-1.1 được ghi addendum, B-1.1 không ghi project.vision/goals", () => {
    expect(writable).toContain("addendum")
    expect(getStep("B-1.1").writes).not.toContain("project.vision")
    expect(getStep("B-1.1").writes).not.toContain("project.goals")
  })

  it("draft/regenerate có addendum lõi mà thiếu set project.vision hoặc project.goals ⇒ lỗi", () => {
    for (const kind of ["draft", "regenerate"]) {
      expect(briefExtractionErrors(withCore, [], "S-1.1", kind).map((e) => e.path)).toEqual(["project.vision", "project.goals"])
      expect(briefExtractionErrors(withCore, [vision], "S-1.1", kind).map((e) => e.path)).toEqual(["project.goals"])
      expect(briefExtractionErrors(withCore, [goals(2)], "S-1.1", kind).map((e) => e.path)).toEqual(["project.vision"])
    }
  })

  it("số mục tiêu phải 1:1 với entry goals; đủ thì qua", () => {
    const [error] = briefExtractionErrors(withCore, [vision, goals(3)], "S-1.1", "draft")
    expect(error).toMatchObject({ rule: "brief_extraction_incomplete", path: "project.goals" })
    expect(error.message).toContain("1:1")
    expect(briefExtractionErrors(withCore, [vision, goals(2)], "S-1.1", "draft")).toEqual([])
  })

  it("dự án không có addendum lõi (cũ) ⇒ ops rỗng vẫn qua; step khác không bị kiểm", () => {
    expect(briefExtractionErrors({ ...FIXTURE, addendum: [core("AD4", "Why now")] }, [], "S-1.1", "draft")).toEqual([])
    expect(briefExtractionErrors(withCore, [], "S-2.1", "draft")).toEqual([])
  })

  it("revision chỉ bị kiểm khi đụng addendum: thêm entry goals thì số mục tiêu tính theo addendum sau lô", () => {
    expect(briefExtractionErrors(withCore, [vision], "S-1.1", "revision")).toEqual([])
    const addGoal = { op: "add" as const, path: "addendum[]", value: { ...core("AD9", "goals") } }
    expect(briefExtractionErrors(withCore, [addGoal, vision, goals(2)], "S-1.1", "revision").map((e) => e.path)).toEqual(["project.goals"])
    expect(briefExtractionErrors(withCore, [addGoal, vision, goals(3)], "S-1.1", "revision")).toEqual([])
  })

  it("S-1.1 chỉ sửa entry addendum lõi: entry thường bị op_out_of_scope, entry lõi và add lõi qua", () => {
    const edit = (id: string) => ({ op: "set", path: `addendum[id=${id}].content_en`, value: "Reworded" })
    expect(validateOps(withCore, [edit("AD2")], { writable, stepId: "S-1.1" })).toEqual([])
    expect(validateOps(withCore, [edit("AD4")], { writable, stepId: "S-1.1" })).toMatchObject([{ rule: "op_out_of_scope", path: "addendum[id=AD4].content_en" }])
    expect(validateOps(withCore, [{ op: "remove", path: "addendum[id=AD4]" }], { writable, stepId: "S-1.1" })[0]).toMatchObject({ rule: "op_out_of_scope" })
    const add = (topic: string) => ({ op: "add", path: "addendum[]", value: { ...core("AD9", topic), topic } })
    expect(validateOps(withCore, [add("goals")], { writable, stepId: "S-1.1" })).toEqual([])
    expect(validateOps(withCore, [add("Risks")], { writable, stepId: "S-1.1" })[0]).toMatchObject({ rule: "op_out_of_scope" })
  })
})

describe("validateOps — Brief chặn chỉ khi giá trị đổi, message ưu tiên", () => {
  const empty: Spine = { ...structuredClone(FIXTURE), project: { ...FIXTURE.project, vision: null, goals: [] } }

  it("set nguyên object project giữ nguyên vision/goals (null, []) qua validateOps ở B-0.1/B-0.3/B-1.6/B-2.3", () => {
    for (const stepId of ["B-0.1", "B-0.3", "B-1.6", "B-2.3"]) {
      const value = { ...empty.project, stakes: "production" }
      expect(validateOps(empty, [{ op: "set", path: "project", value }], { writable: getStep(stepId).writes, stepId }), stepId).toEqual([])
    }
  })

  it("set nguyên object project ĐỔI vision hoặc goals ⇒ path_not_writable; set project.vision = null (giữ nguyên) qua", () => {
    const writable = getStep("B-0.3").writes
    const stepId = "B-0.3"
    expect(validateOps(empty, [{ op: "set", path: "project", value: { ...empty.project, vision: "V" } }], { writable, stepId })[0]).toMatchObject({ rule: "path_not_writable" })
    expect(validateOps(empty, [{ op: "set", path: "project", value: { ...empty.project, goals: ["G"] } }], { writable, stepId })[0]).toMatchObject({ rule: "path_not_writable" })
    expect(validateOps(empty, [{ op: "set", path: "project.vision", value: null }], { writable: [...writable, "project.vision"], stepId })).toEqual([])
  })

  it("B-1.1…B-2.2 (writes không có project.vision): lỗi là hướng dẫn ghi addendum, không phải danh sách writes chung", () => {
    for (const stepId of ["B-1.1", "B-1.2", "B-1.5", "B-2.1", "B-2.2"]) {
      const [error] = validateOps(empty, [{ op: "set", path: "project.vision", value: "V" }], { writable: getStep(stepId).writes, stepId })
      expect(error, stepId).toMatchObject({ rule: "path_not_writable", path: "project.vision" })
      expect(error.message, stepId).toContain("addendum")
      expect(error.message, stepId).not.toContain("Được ghi:")
    }
  })
})

describe("briefExtractionErrors — vision/goals chỉ đòi khi addendum có nguồn, goals 1:1 mọi lô", () => {
  const core = (id: string, topic: string): Spine["addendum"][number] => ({
    id,
    topic,
    content: "Nội dung",
    content_en: "Content",
    target_section: "fixed:1",
    captured_at: "2026-09-30T00:00:00.000Z"
  })
  const goalsOp = (n: number) => ({ op: "set" as const, path: "project.goals", value: Array.from({ length: n }, (_, i) => `Goal ${i + 1}`) })
  const visionOp = { op: "set" as const, path: "project.vision", value: "One English sentence." }
  const goalsOnly: Spine = { ...structuredClone(FIXTURE), addendum: [core("AD1", "goals"), core("AD2", "goals")] }
  const visionOnly: Spine = { ...structuredClone(FIXTURE), addendum: [core("AD1", "vision")] }
  const full: Spine = { ...structuredClone(FIXTURE), addendum: [core("AD1", "vision"), core("AD2", "goals"), core("AD3", "goals"), core("AD4", "goals")] }

  it("chỉ có entry goals ⇒ không đòi project.vision; chỉ có entry vision ⇒ không đòi project.goals", () => {
    for (const kind of ["draft", "regenerate"]) {
      expect(briefExtractionErrors(goalsOnly, [goalsOp(2)], "S-1.1", kind)).toEqual([])
      expect(briefExtractionErrors(goalsOnly, [], "S-1.1", kind).map((e) => e.path)).toEqual(["project.goals"])
      expect(briefExtractionErrors(visionOnly, [visionOp], "S-1.1", kind)).toEqual([])
      expect(briefExtractionErrors(visionOnly, [], "S-1.1", kind).map((e) => e.path)).toEqual(["project.vision"])
    }
  })

  it("revision chỉ set project.goals (không đụng addendum) vẫn bị so 1:1 với entry goals", () => {
    expect(briefExtractionErrors(full, [goalsOp(2)], "S-1.1", "revision").map((e) => e.path)).toEqual(["project.goals"])
    expect(briefExtractionErrors(full, [goalsOp(3)], "S-1.1", "revision")).toEqual([])
    expect(briefExtractionErrors(full, [visionOp], "S-1.1", "revision")).toEqual([])
  })

  it("draft/regenerate đặt sai số mục tiêu ⇒ lỗi; đúng ⇒ qua", () => {
    for (const kind of ["draft", "regenerate"]) {
      expect(briefExtractionErrors(full, [visionOp, goalsOp(2)], "S-1.1", kind).map((e) => e.path)).toEqual(["project.goals"])
      expect(briefExtractionErrors(full, [visionOp, goalsOp(3)], "S-1.1", kind)).toEqual([])
    }
  })
})

describe("sanitizeModelOps — giả định path project.vision|goals ở Brief", () => {
  const core = (id: string, topic: string): Spine["addendum"][number] => ({
    id,
    topic,
    content: "Nội dung",
    content_en: "Content",
    target_section: "fixed:1",
    captured_at: "2026-09-30T00:00:00.000Z"
  })
  const assumption = {
    id: "AS91",
    path: "project.vision",
    statement: "The vision is a booking tool.",
    statement_vi: "Tầm nhìn là công cụ đặt lịch.",
    rationale: "demo",
    origin_step_id: "B-1.4",
    status: "unconfirmed" as const,
    confirmed_at: null
  }
  const spine: Spine = { ...structuredClone(FIXTURE), addendum: [core("AD1", "vision"), core("AD2", "goals")], assumptions: [assumption, { ...assumption, id: "AS92", path: "project.goals[0]" }] }
  const revision = { revision: true, gateAssumptionIds: new Set(["AS91", "AS92"]) }
  const restate = (id: string) => [
    { op: "set", path: `assumptions[id=${id}].statement`, value: "The vision is a clinic queue tool." },
    { op: "set", path: `assumptions[id=${id}].status`, value: "confirmed" }
  ]

  it("set addendum[vision].content(_en) trong revision Brief ⇒ hợp lệ", () => {
    for (const path of ["addendum[id=AD1].content", "addendum[id=AD1].content_en"]) {
      expect(sanitizeModelOps(spine, [{ op: "set", path, value: "x" }, ...restate("AS91")], "B-1.4", new Date(), revision).errors, path).toEqual([])
    }
  })

  it("giả định goals: cần sửa entry topic goals; sửa entry vision không đủ; ngoài Brief không áp", () => {
    expect(sanitizeModelOps(spine, [{ op: "set", path: "addendum[id=AD2].content_en", value: "x" }, ...restate("AS92")], "B-1.4", new Date(), revision).errors).toEqual([])
    expect(sanitizeModelOps(spine, [{ op: "set", path: "addendum[id=AD1].content_en", value: "x" }, ...restate("AS92")], "B-1.4", new Date(), revision).errors.map((e) => e.rule)).toEqual(["assumption_path_mismatch"])
    expect(sanitizeModelOps(spine, [{ op: "set", path: "addendum[id=AD1].content_en", value: "x" }, ...restate("AS91")], "S-1.3", new Date(), revision).errors.map((e) => e.rule)).toEqual(["assumption_path_mismatch"])
  })

  it("không sửa addendum lõi ⇒ vẫn assumption_path_mismatch", () => {
    expect(sanitizeModelOps(spine, restate("AS91"), "B-1.4", new Date(), revision).errors.map((e) => e.rule)).toEqual(["assumption_path_mismatch"])
  })
})

describe("sanitizeModelOps — B-2.1 chỉ đổi status khi user đã quyết trong lượt", () => {
  const assumption = {
    id: "AS90",
    path: "project.form_factor",
    statement: "The product is a web app.",
    statement_vi: "Sản phẩm là ứng dụng web.",
    rationale: "demo",
    origin_step_id: "B-0.1",
    status: "unconfirmed" as const,
    confirmed_at: null
  }
  const spine: Spine = { ...FIXTURE, assumptions: [assumption] }
  const flip = [{ op: "set", path: "assumptions[id=AS90].status", value: "confirmed" }]

  it("không có quyết định của user ⇒ giữ nguyên status, không thêm confirmed_at", () => {
    const { errors, ops } = sanitizeModelOps(spine, flip, "B-2.1")
    expect(errors).toEqual([])
    expect(ops).toEqual([{ op: "set", path: "assumptions[id=AS90].status", value: "unconfirmed" }])
    const whole = [{ op: "set", path: "assumptions[id=AS90]", value: { ...spine.assumptions[0], status: "confirmed", confirmed_at: "2026-01-01" } }]
    const kept = sanitizeModelOps(spine, whole, "B-2.1").ops[0] as { value: { status: string; confirmed_at: string | null } }
    expect(kept.value.status).toBe("unconfirmed")
  })

  it("user đã trả lời/nhắn trong lượt ⇒ model đổi được status, server đặt confirmed_at", () => {
    const { ops } = sanitizeModelOps(spine, flip, "B-2.1", new Date("2026-09-30T00:00:00.000Z"), { userDecided: true })
    expect(ops[0]).toMatchObject({ path: "assumptions[id=AS90].status", value: "confirmed" })
    expect(ops.some((op) => (op as { path: string }).path === "assumptions[id=AS90].confirmed_at")).toBe(true)
  })

  it("step rà giả định khác (B-2.3) không đổi hành vi", () => {
    expect(sanitizeModelOps(spine, flip, "B-2.3").ops[0]).toMatchObject({ value: "confirmed" })
  })
})

describe("useCaseWiringErrors — S-4.1 gắn chức năng màn hình vào use case ngay khi tạo", () => {
  const unwired = (): Spine => {
    const spine = structuredClone(FIXTURE)
    spine.use_cases = spine.use_cases.map((u) => (u.id === "UC01" ? { ...u, function_ids: [] } : u))
    return spine
  }
  const newFunction = {
    op: "add" as const,
    path: "functions[]",
    value: { id: "FN099", screen_id: "S01", feature_id: "F1", order: 99, name: "Do Thing", trigger: "", description: "", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }
  }

  it("lô S-4.1 tạo chức năng mà use case người dùng chưa gắn ⇒ lỗi trỏ đúng use case", () => {
    const errors = useCaseWiringErrors(unwired(), [newFunction], "S-4.1")
    expect(errors).toEqual([expect.objectContaining({ rule: "usecase_not_wired", path: "use_cases[id=UC01].function_ids" })])
  })

  it("gắn trong cùng lô bằng add …function_ids[] ⇒ không lỗi", () => {
    const wire = { op: "add" as const, path: "use_cases[id=UC01].function_ids[]", value: "FN099" }
    expect(useCaseWiringErrors(unwired(), [newFunction, wire], "S-4.1")).toEqual([])
  })

  it("bước khác, hoặc lô S-4.1 không tạo chức năng (vd sửa tên màn) ⇒ không soi", () => {
    expect(useCaseWiringErrors(unwired(), [newFunction], "S-4.4")).toEqual([])
    expect(useCaseWiringErrors(unwired(), [{ op: "set", path: "screens[id=S01].name", value: "Sign In" }], "S-4.1")).toEqual([])
  })
})

describe("dropRedundantScalarAdds — gắn lại liên kết đã có không giết cả lô", () => {
  it("bỏ add giá trị đã có và cặp lặp trong lô; giữ add mới và mọi op khác", () => {
    const existing = FIXTURE.use_cases[0].function_ids[0]
    const ops = [
      { op: "add" as const, path: `use_cases[id=${FIXTURE.use_cases[0].id}].function_ids[]`, value: existing },
      { op: "add" as const, path: `use_cases[id=${FIXTURE.use_cases[0].id}].function_ids[]`, value: "FN099" },
      { op: "add" as const, path: `use_cases[id=${FIXTURE.use_cases[0].id}].function_ids[]`, value: "FN099" },
      { op: "set" as const, path: "actors[id=A01].name", value: "Owner" }
    ]
    expect(dropRedundantScalarAdds(FIXTURE, ops)).toEqual([ops[1], ops[3]])
  })
})
