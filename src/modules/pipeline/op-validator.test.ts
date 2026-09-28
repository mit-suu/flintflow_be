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
})
